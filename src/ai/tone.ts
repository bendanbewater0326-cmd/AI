/**
 * 语气判定（R-045）：同一句话，提问 → 只给建议，命令 → 直接改时间线。
 *
 * ## 为什么判定必须在本文件里、且是纯函数
 *
 * 这条规则决定"要不要动用户的时间线"，判错的代价不对称：
 * 把命令误判成提问，用户再点一次「采纳」即可；把提问误判成命令，用户的内容已经被改了。
 * 因此**默认取安全侧**：拿不准时一律当提问。
 *
 * 纯函数是为了能脱离浏览器单测——判定规则会随真实用法不断调整，没有单测就是玄学。
 */

export type Tone = 'question' | 'command';

export interface ToneVerdict {
  tone: Tone;
  /** 命中的关键词（用于 UI 显示"为什么按建议处理"，也方便排查误判）。 */
  evidence: string[];
}

/** 提问标记：出现任意一个即判提问（优先级最高）。 */
const QUESTION_MARKERS = [
  '为什么',
  '为啥',
  '怎么',
  '如何',
  '建议',
  '能不能',
  '可不可以',
  '是否',
  '要不要',
  '应不应该',
  '哪里',
  '多少',
  '吗',
  '呢',
  '？',
  '?',
  '好不好',
  '怎么样',
];

/** 命令动词：句首（去掉"请/帮我/麻烦"后）命中即判命令。 */
const COMMAND_VERBS = [
  '删',
  '去掉',
  '去除',
  '剪',
  '切',
  '裁',
  '拆',
  '移',
  '拖',
  '缩放',
  '放大',
  '缩小',
  '调',
  '改',
  '加',
  '添加',
  '新建',
  '静音',
  '取消静音',
  // R-061：降噪/去噪是明确的命令动词，不加进来会被"拿不准走安全侧"判成提问
  '降噪',
  '去噪',
  '人声增强',
  '合并',
  '拼',
  '对齐',
  '插入',
  '导出',
  '清空',
  '替换',
];

/** 命令式句式：把字句 / 将字句（动词不一定在句首）。 */
const COMMAND_PATTERNS = [
  /把.+?(删|去掉|移|改|调|放大|缩小|裁|切|剪|静音)/,
  /将.+?(删|去掉|移|改|调|放大|缩小|裁|切|剪|静音)/,
  // 剪辑行话：不带主语也一定是命令（"在播放头切一刀"不以动词开头）
  /(切|剪)一?刀/,
  /切分|切开/,
];

/** 礼貌前缀，判定动词前先剥掉，避免"请帮我删掉"因为不是动词开头被当成提问。 */
const POLITE_PREFIXES = ['请', '帮我', '帮忙', '麻烦', '给我', '能不能帮我', '可以帮我'];

function stripPolite(text: string): string {
  let next = text.trim();
  // 循环剥离："请帮我删掉…" 需要剥两次（请 → 帮我）
  for (let guard = 0; guard < 4; guard += 1) {
    const prefix = POLITE_PREFIXES.find((item) => next.startsWith(item));
    if (prefix === undefined) break;
    next = next.slice(prefix.length).trim();
  }
  return next;
}

/**
 * 判定一句话是提问还是命令。
 *
 * 规则顺序（不可调换）：
 * 1. 空串 → 提问（不执行任何操作）；
 * 2. 出现提问标记 → 提问；
 * 3. 把/将字句 → 命令；
 * 4. 剥掉礼貌前缀后以命令动词开头 → 命令；
 * 5. 其余 → 提问（安全侧）。
 */
export function classifyTone(text: string): ToneVerdict {
  const raw = text.trim();
  if (raw === '') return { tone: 'question', evidence: [] };

  const questionHits = QUESTION_MARKERS.filter((marker) => raw.includes(marker));
  if (questionHits.length > 0) return { tone: 'question', evidence: questionHits };

  const pattern = COMMAND_PATTERNS.find((re) => re.test(raw));
  if (pattern !== undefined) return { tone: 'command', evidence: ['把/将字句'] };

  const stripped = stripPolite(raw);
  const verb = COMMAND_VERBS.find((item) => stripped.startsWith(item));
  if (verb !== undefined) return { tone: 'command', evidence: [verb] };

  return { tone: 'question', evidence: [] };
}
