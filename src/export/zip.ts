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

/* ---------------- 解包（store-only，.vedpack 用） ---------------- */

export interface UnzipEntry {
  name: string;
  data: Uint8Array;
}

export type UnzipResult =
  | { ok: true; entries: Map<string, Uint8Array> }
  | { ok: false; reason: 'not-zip' | 'unsupported' | 'corrupt'; message: string };

/**
 * 解开一个**全部条目为 store 模式**的 ZIP（`createZip` 的自产自销读侧）。
 *
 * 为什么只认 store：.vedpack 的素材（音视频）本身已压缩，deflate 无收益；
 * 而支持解压就要带一份 inflate 实现（约几百行或引依赖）。外部普通 ZIP
 * （deflate 条目）会得到 `unsupported`，调用方给可读中文提示。
 *
 * 逐条目校验 CRC32——store 条目的"完整性"就靠它（防下载损坏/手改）。
 */
export function unzipStore(bytes: Uint8Array): UnzipResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // ---- 1) 从尾部找 EOCD（End of Central Directory）----
  // EOCD 固定 22 字节，但前面可能有最长 65535 字节的注释——从尾向前搜签名。
  let eocd = -1;
  const searchStart = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let i = bytes.byteLength - 22; i >= searchStart; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, reason: 'not-zip', message: '不是 ZIP 文件' };
  const entryCount = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  // ---- 2) 走中央目录：拿每个条目的名字 / 大小 / 本地头偏移 ----
  const entries = new Map<string, Uint8Array>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
      return { ok: false, reason: 'corrupt', message: `ZIP 中央目录损坏（第 ${index} 条）` };
    }
    const method = view.getUint16(cursor + 10, true);
    const crcExpected = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (method !== 0) {
      return { ok: false, reason: 'unsupported', message: `条目 ${name} 使用了压缩（非 store），不支持` };
    }

    // ---- 3) 本地文件头：跳过头 + 名字 + extra，取数据 ----
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
      return { ok: false, reason: 'corrupt', message: `条目 ${name} 的本地头损坏` };
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + size > bytes.byteLength) {
      return { ok: false, reason: 'corrupt', message: `条目 ${name} 的数据不完整` };
    }
    const data = bytes.subarray(dataStart, dataStart + size);
    if (crc32(data) !== crcExpected) {
      return { ok: false, reason: 'corrupt', message: `条目 ${name} 校验失败（数据可能损坏）` };
    }
    entries.set(name, data);

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { ok: true, entries };
}
