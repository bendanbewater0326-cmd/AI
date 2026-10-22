/**
 * 极简 ZIP 写入器（R-062：透明通道导出 = RGBA PNG 序列 + ZIP）。
 *
 * ## 为什么自己写
 *
 * 项目定案是"最小依赖"（package.json 只有 react / mp4-muxer / gifenc）。
 * 而 R-062 需要的只是 **store 模式（不压缩）** 的 ZIP —— PNG 本身已经 deflate 过，
 * 再压一遍几乎没有收益，却要引入几百 KB 的压缩库。
 *
 * ## 格式要点（PKWARE APPNOTE 6.3）
 *
 * ```
 * [local file header + name + data] × N
 * [central directory header + name] × N
 * [end of central directory]
 * ```
 *
 * - 一律 `method = 0`（store），`crc32` 仍然必须正确——解压器会校验；
 * - 文件名用 UTF-8 并置 **通用位标志 bit 11**（`0x0800`），否则中文工程名在 Windows 上会乱码；
 * - 只支持 32 位尺寸（< 4GB）：PNG 序列够用，超了直接报错而不是写出坏包。
 *
 * 不做：目录项、压缩、ZIP64、加密、注释。用不到就不写，少一处出错。
 */

/** CRC-32（IEEE 802.3）查表。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/** 计算 CRC-32（导出供单测用）。 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const index = (crc ^ (bytes[i] ?? 0)) & 0xff;
    crc = (CRC_TABLE[index] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** 包内路径（正斜杠；不支持 `..`）。 */
  name: string;
  data: Uint8Array;
}

export interface CreateZipOptions {
  /** 条目时间戳（默认当前时间）。固定值可让产物可复现。 */
  date?: Date;
}

const MAX_UINT32 = 0xffffffff;
const UTF8_FLAG = 0x0800;
const VERSION = 20; // 2.0 = 支持 store + 目录

/** Date → DOS 时间/日期（本地时区，精度 2 秒）。 */
function toDosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (Math.floor(date.getSeconds() / 2) & 0x1f) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((date.getHours() & 0x1f) << 11),
    date:
      (date.getDate() & 0x1f) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (((year - 1980) & 0x7f) << 9),
  };
}

function assertSafeName(name: string): void {
  if (name === '' || name.includes('\\') || name.startsWith('/') || name.includes('../')) {
    throw new Error(`zip: 非法的条目名 "${name}"`);
  }
}

/**
 * 把若干条目打成 ZIP（store 模式）。
 *
 * 顺序即写入顺序：解压后按名字排序，所以这里保持"帧号顺序"更符合直觉。
 */
export function createZip(entries: ZipEntry[], options: CreateZipOptions = {}): Uint8Array<ArrayBuffer> {
  const stamp = toDosTime(options.date ?? new Date());
  const encoder = new TextEncoder();

  let total = 0;
  for (const entry of entries) {
    assertSafeName(entry.name);
    total += entry.data.length;
  }
  if (total > MAX_UINT32) throw new Error('zip: 总大小超过 4GB，不支持 ZIP64');

  const prepared = entries.map((entry) => ({
    nameBytes: encoder.encode(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
  }));

  // 先算总长，一次性分配：ZIP 里有大量"偏移量"字段，边写边算容易错位
  let localSize = 0;
  for (const item of prepared) {
    localSize += 30 + item.nameBytes.length + item.data.length;
  }
  let centralSize = 0;
  for (const item of prepared) {
    centralSize += 46 + item.nameBytes.length;
  }
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let offset = 0;

  const writeU16 = (value: number): void => {
    view.setUint16(offset, value, true);
    offset += 2;
  };
  const writeU32 = (value: number): void => {
    view.setUint32(offset, value >>> 0, true);
    offset += 4;
  };
  const writeBytes = (bytes: Uint8Array): void => {
    out.set(bytes, offset);
    offset += bytes.length;
  };

  const offsets: number[] = [];
  for (const item of prepared) {
    offsets.push(offset);
    writeU32(0x04034b50); // local file header
    writeU16(VERSION);
    writeU16(UTF8_FLAG);
    writeU16(0); // store
    writeU16(stamp.time);
    writeU16(stamp.date);
    writeU32(item.crc);
    writeU32(item.data.length);
    writeU32(item.data.length);
    writeU16(item.nameBytes.length);
    writeU16(0); // extra
    writeBytes(item.nameBytes);
    writeBytes(item.data);
  }

  const centralStart = offset;
  for (const [index, item] of prepared.entries()) {
    writeU32(0x02014b50); // central directory header
    writeU16(VERSION); // version made by
    writeU16(VERSION); // version needed
    writeU16(UTF8_FLAG);
    writeU16(0); // store
    writeU16(stamp.time);
    writeU16(stamp.date);
    writeU32(item.crc);
    writeU32(item.data.length);
    writeU32(item.data.length);
    writeU16(item.nameBytes.length);
    writeU16(0); // extra
    writeU16(0); // comment
    writeU16(0); // disk number
    writeU16(0); // internal attrs
    writeU32(0); // external attrs
    writeU32(offsets[index] ?? 0);
    writeBytes(item.nameBytes);
  }
  const centralSizeActual = offset - centralStart;

  writeU32(0x06054b50); // end of central directory
  writeU16(0);
  writeU16(0);
  writeU16(prepared.length);
  writeU16(prepared.length);
  writeU32(centralSizeActual);
  writeU32(centralStart);
  writeU16(0);

  return out;
}
