/**
 * 应用内自检（在客户端里点一下就能验证"这个环境到底能不能正常剪"）。
 *
 * ## 为什么要有
 *
 * 自动测试（`npm run e2e`，43 个脚本）跑在**无头 Chrome** 里，用户看不到也跑不了；
 * 而"在我这台机器 / 这个客户端面板里能不能用"是另一回事（WebCodecs 可用性、
 * 音频设备采样率、面板是否限制了某些 API）。所以这里给一个人能点的入口：
 * 顶栏「自检」→ 依次跑 6 项 → 绿/红 + 具体数值。
 *
 * ## 用测试钩子而不是重写一遍逻辑
 *
 * `window.__VEDITOR_TEST__`（非生产构建注入）已经暴露了素材/解码/预览/音频统计，
 * 直接拿来用，避免"自检代码和真实代码各写一套、结论不一致"。
 * 生产构建里没有这个钩子，面板会提示"需要在开发构建下运行"——这是预期的。
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { framesPerSecond } from '../core/timebase';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface Hooks {
  clips: () => Array<{ id: string; assetId: string; startFrame: number; durationFrames: number }>;
  assets: () => Array<{
    id: string;
    name: string;
    width: number;
    height: number;
    fpsMilli: number;
    sampleRate: number;
    channels: number;
    hasAudio: boolean;
  }>;
  decodeTest: (assetId: string, frame: number) => Promise<{ ok: boolean; detail: string } | null>;
  previewSnapshot: () => Promise<{ nonBlack: number; total: number; meanLuma: number } | null>;
  audioStats: () => {
    chunks: number;
    gaps: number;
    audible: boolean;
    scheduledSeconds: number;
    lastGapError: string;
    gapReasons: { noPoolOrAsset: number; noAudioSamples: number; noAssetFrame: number; decodeFailed: number };
  } | null;
  playheadFrame: () => number;
  seek: (frame: number) => void;
  audioProbe: () => {
    buffers: number;
    peak: number;
    rms: number;
    clipped: number;
    sampleRate: number;
    channels: number;
    contextState: string;
  } | null;
  domProbe: () => {
    point?: { x: number; y: number };
    topElement?: string | null;
    canvasOnTop?: boolean;
    scrollX?: number;
    frameAtCenter?: number;
    playhead?: number;
    docVersion?: number;
    bodyPointerEvents?: string;
    why?: string;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    results.push({ name, ok, detail });
  };

  // ① 运行环境
  const codecs = {
    VideoDecoder: typeof VideoDecoder !== 'undefined',
    AudioDecoder: typeof AudioDecoder !== 'undefined',
    VideoEncoder: typeof VideoEncoder !== 'undefined',
  };
  add(
    '① 运行环境（WebCodecs）',
    codecs.VideoDecoder && codecs.AudioDecoder,
    `解码 ${codecs.VideoDecoder ? '✓' : '✗'} / 音频 ${codecs.AudioDecoder ? '✓' : '✗'} / 编码 ${codecs.VideoEncoder ? '✓' : '✗'} · secure=${window.isSecureContext}`,
  );

  const hooks = (window as unknown as { __VEDITOR_TEST__?: Hooks }).__VEDITOR_TEST__;
  if (hooks === undefined) {
    add('② 测试钩子', false, '当前是生产构建，自检只能在开发构建（npm run dev）下跑');
    return results;
  }

  // ② 素材
  const clips = hooks.clips();
  const assets = hooks.assets();
  const asset = assets[0];
  add(
    '② 素材已导入',
    clips.length > 0 && asset !== undefined,
    asset === undefined
      ? '素材栏是空的：先拖一个视频进来'
      : `${asset.name} · ${asset.width}×${asset.height} · ${framesPerSecond(asset.fpsMilli)}fps · 音频 ${asset.sampleRate}Hz ${asset.channels}ch`,
  );

  if (asset === undefined) return results;

  // ③ 解码
  //
  // `decodeTest` 直接向池要一帧，会 bump epoch **取消引擎正在跑的渲染**
  // （错误文本是"seek 被新的 epoch 取消"）。那是竞态不是失败，重试一次即可。
  let decoded = await hooks.decodeTest(asset.id, 0);
  if (decoded !== null && !decoded.ok && /epoch 取消/.test(decoded.detail)) {
    await sleep(200);
    decoded = await hooks.decodeTest(asset.id, 0);
  }
  add(
    '③ 解码首帧',
    decoded?.ok === true,
    decoded === null ? '解码器不可用' : decoded.ok ? 'OK' : decoded.detail,
  );

  // ③ 把渲染叫回来：上面那次 decodeTest 取消了引擎的在飞渲染，
  // 不重画的话 ④ 会拍到黑帧（用户第一次自检就踩到：③④ 同时红）。
  hooks.seek(hooks.playheadFrame());
  await sleep(300);

  // ④ 预览出画
  const snapshot = await hooks.previewSnapshot();
  add(
    '④ 预览出画',
    (snapshot?.nonBlack ?? 0) > 0,
    snapshot === null ? '预览引擎未就绪' : `非黑像素 ${snapshot.nonBlack} / ${snapshot.total}`,
  );

  // ⑤ 音频排期
  //
  // **不能拿"chunks 有没有增加"当判据**：预读窗口通常早就把整段排完了，
  // 播 0.6 秒期间不会再排新块（实测 chunks 714 → 714，看着像失败，其实一切正常）。
  // 正确判据是"当前播放位置可听 + 没有空洞"。
  // 先把播放头挪到**第一个片段内部**再播：否则播放头可能停在空白处，
  // `audible` 会是 false，看起来像"音频坏了"（用户第一次自检就被这个坑到）。
  const firstClip = clips[0];
  if (firstClip !== undefined) hooks.seek(firstClip.startFrame);
  await sleep(200);
  const button = document.querySelector<HTMLButtonElement>('[data-v="play-toggle"]');
  button?.click();
  await sleep(600);
  const stats = hooks.audioStats();
  button?.click();
  if (stats === null) {
    add('⑤ 音频排期', false, '音频调度未启动（播放没开始？）');
  } else if (!asset.hasAudio) {
    add('⑤ 音频排期', true, '该素材本身没有音频轨（跳过）');
  } else {
    // gaps 有值时把**原因拆开**：空洞可能来自解码失败、时间线没帧、或池/素材缺失，
    // 只报一个总数没法定位（用户报过 gaps 537，但看不出是哪种）。
    const reasons = stats.gapReasons;
    const reasonText =
      stats.gaps === 0
        ? ''
        : `（解码失败 ${reasons.decodeFailed} / 无素材帧 ${reasons.noAssetFrame} / 无音频样本 ${reasons.noAudioSamples} / 池缺失 ${reasons.noPoolOrAsset}）`;
    add(
      '⑤ 音频排期',
      stats.chunks > 0 && stats.gaps === 0 && stats.audible,
      `chunks ${stats.chunks} · gaps ${stats.gaps}${reasonText} · 当前可听 ${stats.audible ? '是' : '否'} · 已排期 ${stats.scheduledSeconds.toFixed(1)}s${
        stats.lastGapError === '' ? '' : ` · ${stats.lastGapError}`
      }`,
    );
  }

  // ⑥ 播放头可推进
  add(
    '⑥ 播放头',
    Number.isFinite(hooks.playheadFrame()),
    `当前第 ${hooks.playheadFrame()} 帧`,
  );

  // ⑦ 已排期 PCM 的波形（区分"没声音"和"声音失真"）
  const pcm = hooks.audioProbe();
  if (pcm === null || pcm.buffers === 0) {
    add('⑦ 音频波形', false, '还没排期任何 PCM（先播一下再自检）');
  } else {
    add(
      '⑦ 音频波形',
      pcm.clipped === 0 && pcm.peak <= 1.001 && pcm.contextState === 'running',
      `峰值 ${pcm.peak.toFixed(3)} · RMS ${pcm.rms.toFixed(3)} · 削顶样本 ${pcm.clipped} · ${pcm.sampleRate}Hz ${pcm.channels}ch · 上下文 ${pcm.contextState}`,
    );
  }

  // ⑧ 时间线中心处最上层是谁（"点不动"时用来看有没有透明遮罩）
  const dom = hooks.domProbe();
  add(
    '⑧ 时间线可点',
    dom.canvasOnTop === true,
    dom.why !== undefined
      ? dom.why
      : `中心点最上层 ${dom.topElement} · 播放头 ${dom.playhead} · 中心帧 ${dom.frameAtCenter} · scrollX ${dom.scrollX} · doc v${dom.docVersion}`,
  );

  return results;
}

export function SelfCheckPanel({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement | null {
  const [results, setResults] = useState<CheckResult[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRunning(true);
    setResults([]);
    void (async () => {
      try {
        setResults(await runChecks());
      } finally {
        setRunning(false);
      }
    })();
  }, [open]);

  if (!open) return null;

  const failed = results.filter((item) => !item.ok).length;
  const summary = running ? '自检中…' : failed === 0 ? '全部通过' : `${failed} 项未通过`;

  return (
    <div className="v-selfcheck" data-v="self-check-panel" role="dialog" aria-label="自检">
      <div className="v-selfcheck__head">
        <strong>自检 · {summary}</strong>
        <button type="button" data-v="self-check-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>
      <ul className="v-selfcheck__list">
        {results.map((item) => (
          <li key={item.name} className={item.ok ? 'v-selfcheck__ok' : 'v-selfcheck__bad'}>
            <span>{item.ok ? '✅' : '❌'}</span>
            <span className="v-selfcheck__name">{item.name}</span>
            <span className="v-selfcheck__detail">{item.detail}</span>
          </li>
        ))}
      </ul>
      <div className="v-selfcheck__foot">
        <button
          type="button"
          data-v="self-check-rerun"
          disabled={running}
          onClick={() => {
            setRunning(true);
            void (async () => {
              try {
                setResults(await runChecks());
              } finally {
                setRunning(false);
              }
            })();
          }}
        >
          重新自检
        </button>
        <button
          type="button"
          data-v="self-check-copy"
          onClick={() => {
            const text = results
              .map((item) => `${item.ok ? '[OK]' : '[FAIL]'} ${item.name} — ${item.detail}`)
              .join('\n');
            void navigator.clipboard?.writeText(text);
          }}
        >
          复制结果
        </button>
      </div>
    </div>
  );
}
