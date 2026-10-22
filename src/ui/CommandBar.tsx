/**
 * AI 命令栏（M4 / R-044~R-046）：默认不存在于 DOM，`Ctrl/Cmd+K` 才浮出。
 *
 * ## 三条硬约束
 *
 * 1. **覆盖式浮层**：`position:absolute` 浮在时间线上方，不改任何区块尺寸（P1 像素级还原）；
 *    Esc 关闭后组件直接 `return null`，DOM 里不留任何 AI 元素。
 * 2. **建议模式不动数据**：提问式输入只写 `ephemeral.overlayMarks`（纯绘制）并给文字理由，
 *    用户点「采纳」才 `dispatch`；执行模式才改时间线，且一次输入 = 一个撤销步。
 * 3. **隐私说明常驻一行**：发送前就告诉用户会发什么（指令 + 工程结构，不上传素材）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { store, useSelection } from '../core/store';
import { compileIntents, compileMarkAcceptance } from '../ai/intents';
import type { AIIntent } from '../ai/intents';
import { buildProjectContext, serializeContext } from '../ai/context';
import { getAIProvider } from '../ai/registry';
import { classifyTone } from '../ai/tone';
import { parseSilenceRequest, planSilenceRemoval } from '../ai/roughCut';
import { DEFAULT_DENOISE, parseDenoiseRequest } from '../media/denoise';
import { curveFromPhrase } from '../render/curve';
import { maskFromPhrase } from '../render/mask';
import { parseMulticamRequest, planMulticam } from '../ai/multicam';
import { parseTranscribeRequest, transcribeTimeline } from '../ai/transcribe';
import type { MaskParams } from '../render/mask';
import { frameToUs, usToSeconds } from '../core/timebase';
import type { OverlayMark } from '../core/types';
import { createId } from '../core/types';

interface CommandBarProps {
  open: boolean;
  onClose: () => void;
  /** 执行成功后回调（App 负责弹 toast，命令栏不持有全局提示状态）。 */
  onApplied: (label: string, opsCount: number) => void;
}

type Phase = 'idle' | 'thinking' | 'suggest' | 'error';

/**
 * "像命令"的判定（本地规则专用）。
 *
 * `classifyTone` 的默认是"拿不准算提问"——这对**破坏性操作**是对的，
 * 但"对比更强""遮住左边"这类说法没有动词，会被判成提问从而不执行。
 * 这里放宽一层：带动作/方位词且**没有疑问词**，才当成命令。
 */
function looksImperativeFor(text: string): boolean {
  // `机位` / `跟说话` 是 R-057 的说法："多机位每 2 秒切一次"不以动词开头，
  // 只靠 `classifyTone` 会被"拿不准算提问"挡下（明明是个命令却什么都不做）。
  const action = /(调|提|压|增强|降低|强|弱|亮|暗|遮|盖|蒙版|遮罩|机位|跟说话)/.test(text);
  const question = /(为什么|怎么|如何|吗|呢|\?|？|要不要|能不能)/.test(text);
  return action && !question;
}

interface SuggestionState {
  message: string;
  marks: OverlayMark[];
}

export function CommandBar({ open, onClose, onApplied }: CommandBarProps): ReactElement | null {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [suggestion, setSuggestion] = useState<SuggestionState | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  /** 长任务（音频分析）期间按钮上的文字：用户要看到"在分析音频"而不是干等。 */
  const [thinkingLabel, setThinkingLabel] = useState('思考中');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selection = useSelection();

  // 每次打开：清空上一轮结果（界面不保留聊天记录，R-045）
  // 挂载 = 刚打开（组件由 App **条件挂载**，每次打开都是全新实例）。
  // 这里只做"聚焦"和"卸载时清标记"，**不再重置 state**：
  // 重置放在 effect 里会和用户的第一下输入抢时序（effect 在首帧后跑，把刚打的字清掉）。
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      store.clearOverlayMarks();
    };
  }, []);

  // Esc 关闭并清掉建议标记（单次即消失）
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close(): void {
    store.clearOverlayMarks();
    setSuggestion(null);
    setPhase('idle');
    onClose();
  }

  async function submit(): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '' || phase === 'thinking') return;
    const provider = getAIProvider();
    const verdict = classifyTone(trimmed);
    const doc = store.getDoc();
    const selectedClipId = selection;
    const context = buildProjectContext(doc, selectedClipId);
    setPhase('thinking');
    setThinkingLabel('思考中');
    setErrorText(null);
    setSuggestion(null);

    // 粗剪必须**在调模型之前**拦下：模型看不到波形，给不出停顿帧号。
    // 这里只认命令式（提问式由 classifyTone 挡在前面，避免"这段停顿怎么处理"被执行）。
    if (verdict.tone === 'command') {
      const silence = parseSilenceRequest(trimmed);
      if (silence !== null) {
        await runSilenceCut(silence.minSilenceSeconds);
        return;
      }
      // 降噪同理：本地 DSP，不需要模型
      if (parseDenoiseRequest(trimmed)) {
        runDenoise();
        return;
      }
    }

    // 曲线（R-055）：本地规则。"对比更强"这类说法不含动词，`classifyTone` 会保守判成提问，
    // 但它语义上就是命令——所以这里放宽一层：带"调/提/压/增强/降低/强/弱"就按命令处理。
    // 多机位（R-057）：需要异步分析音频，放在其它本地规则之前
    const multicam = parseMulticamRequest(trimmed);
    if (multicam !== null && (verdict.tone === 'command' || looksImperativeFor(trimmed))) {
      await runMulticam(multicam);
      return;
    }

    // 自动字幕（R-059）：需要宿主的转写通道。**必须本地拦**——模型只能编文本，
    // 拿不到音频也给不出时间戳。没有通道时给可读拒绝，不落进模型那条路。
    const transcribeRequest = parseTranscribeRequest(trimmed);
    if (transcribeRequest !== null) {
      await runTranscribe(transcribeRequest.language);
      return;
    }

    // 蒙版（R-056）：方位词 → 蒙版参数，同样是本地规则
    const maskPhrase = maskFromPhrase(trimmed);
    if (maskPhrase !== null && (verdict.tone === 'command' || looksImperativeFor(trimmed))) {
      runMask(maskPhrase);
      return;
    }

    const curve = curveFromPhrase(trimmed);
    // 语气判定的默认是"拿不准算提问"（安全侧）。这里只在**明确不是提问**时放宽：
    // 带"调/提/压/亮/暗…"且没有疑问词，才当成命令执行。
    const looksImperative = looksImperativeFor(trimmed);
    if (curve !== null && (verdict.tone === 'command' || looksImperative)) {
      runCurve(curve);
      return;
    }

    const result = await provider.complete({
      text: trimmed,
      tone: verdict.tone,
      doc,
      selectedClipId,
      playheadFrame: store.getPlayheadFrame(),
      contextJson: serializeContext(context),
    });

    if (!result.ok) {
      setPhase('error');
      setErrorText(result.error.detail ? `${result.error.message}：${result.error.detail}` : result.error.message);
      return;
    }

    const { message, intents } = result.value;

    // 模型也可能返回 removeSilence（它只判意图，位置仍由本地分析决定）
    const silenceIntent = intents.find((intent) => intent.kind === 'removeSilence');
    if (silenceIntent !== undefined) {
      await runSilenceCut(
        usToSeconds(frameToUs(silenceIntent.minSilenceFrames, store.getDoc().fpsMilli)),
      );
      return;
    }

    // ---- 建议模式：只写 ephemeral，不动 doc、不入栈 ----
    if (verdict.tone === 'question') {
      const marks: OverlayMark[] = [];
      for (const intent of intents) {
        if (intent.kind !== 'suggestCut') continue;
        marks.push({
          id: `mark_${intent.frame}_${marks.length}`,
          frame: intent.frame,
          kind: 'suggestedCut',
          label: intent.label,
          actionable: true,
        });
      }
      store.setOverlayMarks(marks);
      setSuggestion({ message, marks });
      setPhase('suggest');
      return;
    }

    // ---- 执行模式：编译 → 校验 → 一次撤销步 ----
    applyIntents(intents, message);
  }

  /**
   * 粗剪执行：分析音频 → 一次性 dispatch（一个撤销步）。
   *
   * 为什么整个过程都在命令栏里：用户按 Ctrl+K 说一句话，就要看到"在分析音频"这种即时反馈；
   * 把分析丢到后台再弹 toast，用户会以为没反应而重复按。
   */
  async function runSilenceCut(minSilenceSeconds: number): Promise<void> {
    setPhase('thinking');
    setThinkingLabel('分析音频…');
    const plan = await planSilenceRemoval({
      doc: store.getDoc(),
      minSilenceSeconds,
      selectedClipId: selection,
      onStage: (stage) => setThinkingLabel(`${stage}…`),
    });
    if (!plan.ok) {
      setPhase('error');
      setErrorText(
        plan.error.detail ? `${plan.error.message}（${plan.error.detail}）` : plan.error.message,
      );
      return;
    }
    const value = plan.value;
    store.dispatch(value.ops, value.summary, 'ai');
    onApplied(value.summary, value.ops.length);
    close();
  }

  /**
   * 自然语言开降噪（R-061）：选中片段优先，否则找第一段有声音的片段。
   *
   * 为什么不问参数：一句话里说"降噪"时用户要的是"把底噪压掉"，
   * 门限/强度用默认值即可，细调在属性栏（那里有滑块和实时预览）。
   */
  function runDenoise(): void {
    const doc = store.getDoc();
    let target = selection === null
      ? null
      : doc.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selection) ?? null;
    if (target === null) {
      target =
        doc.tracks
          .flatMap((track) => track.clips)
          .find((clip) => doc.assets.find((asset) => asset.id === clip.assetId)?.hasAudio === true) ?? null;
    }
    if (target === null) {
      setPhase('error');
      setErrorText('没有可降噪的片段（先选中一段有声音的素材）');
      return;
    }
    if (target.effects.some((effect) => effect.type === 'denoise' && effect.enabled)) {
      setPhase('error');
      setErrorText('这段已经开着降噪了');
      return;
    }
    store.dispatch(
      [
        {
          op: 'setClipEffect',
          clipId: target.id,
          effectType: 'denoise',
          from: null,
          to: {
            id: createId('fx'),
            clipId: target.id,
            type: 'denoise',
            params: { ...DEFAULT_DENOISE },
            keyframes: [],
            enabled: true,
            order: 0,
            source: 'ai',
          },
        },
      ],
      '开启降噪',
      'ai',
    );
    onApplied('开启降噪', 1);
    close();
  }

  /**
   * 多机位（R-057）：按机位轨生成切换序列，一次 dispatch = 一个撤销步。
   */
  async function runMulticam(request: { followAudio: boolean; switchSeconds?: number }): Promise<void> {
    setPhase('thinking');
    setThinkingLabel(request.followAudio ? '分析各机位音量…' : '生成切换序列…');
    const plan = await planMulticam({
      doc: store.getDoc(),
      followAudio: request.followAudio,
      ...(request.switchSeconds === undefined ? {} : { switchSeconds: request.switchSeconds }),
      onStage: (stage) => setThinkingLabel(`${stage}…`),
    });
    if (!plan.ok) {
      setPhase('error');
      setErrorText(plan.error.detail ? `${plan.error.message}（${plan.error.detail}）` : plan.error.message);
      return;
    }
    store.dispatch(plan.value.ops, plan.value.summary, 'ai');
    onApplied(plan.value.summary, plan.value.ops.length);
    close();
  }

  /**
   * 自动生成字幕（R-059）：抽音频 → 宿主转写 → 整段替换字幕轨（一个撤销步）。
   *
   * 没有转写通道时**在本地就拒绝**（可读错误），不落进模型那条路：
   * 模型拿不到音频，硬走只会编出没有时间戳的文本。
   */
  async function runTranscribe(language: string): Promise<void> {
    const provider = getAIProvider();
    if (provider.transcribe === undefined) {
      setPhase('error');
      setErrorText(
        `当前客户端未提供语音识别通道，无法自动生成字幕（${provider.label}）。` +
          '可以让宿主注入 transcribe()，或先用外部工具生成 SRT 再导入。',
      );
      return;
    }
    setPhase('thinking');
    setThinkingLabel('抽取音频…');
    const outcome = await transcribeTimeline({
      doc: store.getDoc(),
      transcribe: provider.transcribe.bind(provider),
      language,
      onStage: (stage) => setThinkingLabel(`${stage}…`),
    });
    if (!outcome.ok) {
      setPhase('error');
      setErrorText(
        outcome.error.detail ? `${outcome.error.message}（${outcome.error.detail}）` : outcome.error.message,
      );
      return;
    }
    const { cues, ops, dropped, replaced, durationSec } = outcome.value;
    const summary = `生成字幕（${cues.length} 条${dropped > 0 ? `，丢弃 ${dropped} 条坏片段` : ''}${
      replaced > 0 ? `，替换旧字幕 ${replaced} 条` : ''
    }）`;
    store.dispatch(ops, summary, 'ai');
    onApplied(`${summary} · 识别 ${durationSec.toFixed(1)} 秒音频`, ops.length);
    close();
  }

  /** 自然语言加蒙版（R-056）：选中片段优先，否则第一段视频片段。 */
  function runMask(mask: MaskParams): void {
    const doc = store.getDoc();
    const clips = doc.tracks.flatMap((track) => track.clips);
    const target =
      (selection === null ? null : clips.find((clip) => clip.id === selection) ?? null) ??
      clips.find((clip) => clip.text === null || clip.text === undefined) ??
      null;
    if (target === null) {
      setPhase('error');
      setErrorText('没有可加蒙版的片段');
      return;
    }
    const current = target.effects.find((effect) => effect.type === 'mask') ?? null;
    store.dispatch(
      [
        {
          op: 'setClipEffect',
          clipId: target.id,
          effectType: 'mask',
          from: current,
          to: {
            id: current?.id ?? createId('fx'),
            clipId: target.id,
            type: 'mask',
            params: {
              shape: mask.shape,
              x: mask.x,
              y: mask.y,
              w: mask.w,
              h: mask.h,
              feather: mask.feather,
              invert: mask.invert ? 1 : 0,
            },
            keyframes: current?.keyframes ?? [],
            enabled: true,
            order: 0,
            source: 'ai',
          },
        },
      ],
      '添加蒙版',
      'ai',
    );
    // 选中刚加蒙版的片段：否则属性栏是"未选中"态，用户根本看不到蒙版参数，
    // 也没法细调（蒙版是唯一一条"参数在属性栏、命令栏只给方位词"的效果）。
    store.setSelectedClipId(target.id);
    onApplied('添加蒙版', 1);
    close();
  }

  /** 自然语言调曲线（R-055）：选中片段优先，否则第一段视频片段。 */
  function runCurve(curve: { x1: number; y1: number; x2: number; y2: number }): void {
    const doc = store.getDoc();
    const clips = doc.tracks.flatMap((track) => track.clips);
    const target =
      (selection === null ? null : clips.find((clip) => clip.id === selection) ?? null) ??
      clips.find((clip) => clip.text === null || clip.text === undefined) ??
      null;
    if (target === null) {
      setPhase('error');
      setErrorText('没有可调色的片段');
      return;
    }
    const current = target.effects.find((effect) => effect.type === 'curve') ?? null;
    store.dispatch(
      [
        {
          op: 'setClipEffect',
          clipId: target.id,
          effectType: 'curve',
          from: current,
          to: {
            id: current?.id ?? createId('fx'),
            clipId: target.id,
            type: 'curve',
            params: { ...curve },
            keyframes: [],
            enabled: true,
            order: 0,
            source: 'ai',
          },
        },
      ],
      '调整曲线',
      'ai',
    );
    onApplied('调整曲线', 1);
    close();
  }

  function applyIntents(intents: AIIntent[], message: string): void {
    const doc = store.getDoc();
    const compiled = compileIntents(doc, intents);
    if (!compiled.ok) {
      setPhase('error');
      setErrorText(compiled.error);
      return;
    }
    const label = compiled.summary !== '' ? compiled.summary : message !== '' ? message : 'AI 修改';
    store.dispatch(compiled.ops, label, 'ai');
    onApplied(label, compiled.ops.length);
    close();
  }

  function acceptSuggestion(): void {
    if (suggestion === null) return;
    const marks = suggestion.marks;
    if (marks.length === 0) return;
    const doc = store.getDoc();
    const allOps = [];
    for (const mark of marks) {
      const compiled = compileMarkAcceptance(doc, mark.frame);
      if (compiled.ok) allOps.push(...compiled.ops);
    }
    if (allOps.length === 0) {
      setPhase('error');
      setErrorText('这个位置切不动（切点落在片段首尾或素材边界外）');
      return;
    }
    store.clearOverlayMarks();
    store.dispatch(allOps, '采纳 AI 建议切点', 'ai');
    onApplied('采纳 AI 建议切点', allOps.length);
    close();
  }

  if (!open) return null;
  const provider = getAIProvider();

  return (
    <div className="v-cmdbar" data-v="command-bar" role="dialog" aria-label="AI 命令栏">
      <div className="v-cmdbar__row">
        <span className="v-cmdbar__spark" aria-hidden="true">
          ✦
        </span>
        <input
          ref={inputRef}
          data-v="command-input"
          className="v-cmdbar__input"
          placeholder="说一句要改什么，例如「剪掉开头 3 秒」；问「这里为什么要切」只会给建议"
          value={text}
          disabled={phase === 'thinking'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button
          type="button"
          className="v-cmdbar__run"
          data-v="command-run"
          disabled={phase === 'thinking' || text.trim() === ''}
          onClick={() => void submit()}
        >
          {phase === 'thinking' ? thinkingLabel : '执行'}
        </button>
        <button type="button" className="v-cmdbar__close" data-v="command-close" aria-label="关闭" onClick={close}>
          ✕
        </button>
      </div>

      <div className="v-cmdbar__privacy" data-v="command-privacy">
        {`将发送：指令文本 + 帧率/时长/轨道结构（${provider.label}）· 不上传素材`}
      </div>

      {phase === 'suggest' && suggestion !== null ? (
        <div className="v-cmdbar__result" data-v="command-suggestion">
          <p className="v-cmdbar__message">{suggestion.message}</p>
          {suggestion.marks.length > 0 ? (
            <button type="button" className="v-cmdbar__accept" data-v="command-accept" onClick={acceptSuggestion}>
              {`采纳切点（第 ${suggestion.marks.map((mark) => mark.frame).join('、')} 帧）`}
            </button>
          ) : null}
        </div>
      ) : null}

      {phase === 'error' && errorText !== null ? (
        <div className="v-cmdbar__result v-cmdbar__result--error" data-v="command-error">
          {errorText}
        </div>
      ) : null}
    </div>
  );
}
