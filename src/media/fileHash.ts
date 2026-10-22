/**
 * 文件内容指纹（**只读前 1MB**）。
 *
 * ## 为什么不全文件哈希
 *
 * 重链是"用户点了按钮、等着看画面回来"的交互。4K 素材动辄几 GB，
 * 全文件 SHA-256 要几秒到几十秒，还得把整个文件读进内存（移动端直接 OOM）。
 *
 * 前 1MB 足够区分"同一个文件"和"另一个文件"：mp4 的 `ftyp`/`moov` 都在头部，
 * 编码参数、时长表、关键帧索引全在里面 —— 同编码但内容不同的文件，头 1MB 一定不同。
 * 反过来，**同一个文件**即使被改名/移动，前 1MB 也逐字节相同。这正是重链需要的两个性质。
 *
 * ## 为什么要降级实现
 *
 * `crypto.subtle` 只在**安全上下文**（https / localhost / file）可用。
 * 内嵌面板或 http 内网地址下它是 `undefined` —— 那时不能直接放弃指纹
 * （否则批量重链只能靠文件名，容易错链），改用 FNV-1a 32 位。
 * FNV 的碰撞概率比 SHA-256 高，但配合"文件名 + 大小 + 时长"三个条件，
 * 误判概率可以忽略。
 */

/** 参与哈希的字节数（1MB）。 */
export const HASH_HEAD_BYTES = 1024 * 1024;

/**
 * 算文件指纹，返回形如 `sha256:ab12…` / `fnv:1a2b3c4d`。
 *
 * 前缀是**刻意加的**：将来换算法时，旧工程里的指纹仍能识别出"这是旧算法算的"，
 * 匹配时可以只做"大小 + 时长"降级，而不是拿两种算法去比。
 */
export async function hashFileHead(file: Blob, bytes: number = HASH_HEAD_BYTES): Promise<string> {
  const head = file.slice(0, Math.min(bytes, file.size));
  const buffer = await head.arrayBuffer();
  const view = new Uint8Array(buffer);

  const subtle = globalThis.crypto?.subtle;
  if (subtle !== undefined) {
    try {
      const digest = await subtle.digest('SHA-256', buffer);
      const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return `sha256:${hex}`;
    } catch {
      // 落到 FNV（某些环境下 subtle 存在但调用被拒）
    }
  }
  return `fnv:${fnv1a(view)}`;
}

/** FNV-1a 32 位（无 crypto.subtle 时的降级指纹）。 */
export function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index] ?? 0;
    // Math.imul 保证 32 位乘法（`*` 会溢出成浮点）
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 两个指纹是否"能比"。
 *
 * 算法不同（`sha256:` vs `fnv:`）时**不能**直接比字符串 —— 它们必然不等，
 * 但那不代表文件不同。这种情况返回 false，让调用方降级到别的判据。
 */
export function hashComparable(left: string | null | undefined, right: string | null | undefined): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left === '' || right === '') return false;
  const leftPrefix = left.slice(0, left.indexOf(':'));
  const rightPrefix = right.slice(0, right.indexOf(':'));
  return leftPrefix !== '' && leftPrefix === rightPrefix;
}
