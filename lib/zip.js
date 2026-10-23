/**
 * Session Port — dependency-free ZIP container reading and writing.
 *
 * DSH's shipped session-log export produces a ZIP built by fflate's streaming
 * writer: entries are written with a local file header whose CRC/size fields
 * are zero (flag bit 3 means "data descriptor follows"), and the authoritative
 * values only exist in the central directory. This module therefore locates the
 * end-of-central-directory (EOCD) record, walks the central directory, and
 * takes every size and offset from there; local headers are used only to skip
 * the name/extra fields in front of the payload. That also makes the reader
 * work for ordinary ZIP files produced by other tools.
 *
 * Writer contract: standard ZIP with version-20 local headers, the UTF-8 name
 * flag (bit 11), deflate (method 8) or store (method 0) payloads, CRC-32, a
 * central directory, and a single-disk EOCD. Entry names are written as opaque
 * UTF-8 bytes, so names containing ':' or other characters that are illegal on
 * Windows filesystems are preserved inside the archive.
 *
 * ZIP64 and encrypted entries are intentionally not supported; both raise a
 * readable Error carrying a stable `error.code`. Only `node:zlib` and
 * `node:buffer` are used — there are no third-party dependencies.
 *
 * @module dsh-session-port/zip
 */

import { createDeflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// ---------------------------------------------------------------------------
// ZIP format constants
// ---------------------------------------------------------------------------

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_ZIP_COMMENT_SIZE = 0xffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

const ZIP64_UINT16 = 0xffff;
const ZIP64_UINT32 = 0xffffffff;

const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 20;

/** Fixed DOS time: 00:00:00, so writes are byte-for-byte reproducible. */
const DOS_TIME = 0x0000;
/** Fixed DOS date: 1980-01-01, the earliest timestamp the format can carry. */
const DOS_DATE = 0x0021;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Build an Error with a stable, machine-readable code and a human-readable
 * message. Callers (host UI / locale layer) may localize by `error.code`.
 * @param {string} code - stable failure code, e.g. `EOCD_NOT_FOUND`.
 * @param {string} message - human-readable diagnostic (Chinese).
 * @param {unknown} [cause] - optional underlying failure.
 * @returns {Error} the constructed error.
 */
function zipError(code, message, cause) {
  const error = new Error(message);
  error.name = 'SessionPortZipError';
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * One-line description of a value's type, for argument errors.
 * @param {unknown} value - any value.
 * @returns {string} type description.
 */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'Array';
  return typeof value;
}

/**
 * Coerce a Buffer / Uint8Array (or ArrayBuffer view) into a Buffer without
 * copying when possible. Used by every public entry point.
 * @param {unknown} value - candidate binary value.
 * @param {string} label - argument label used in the error message.
 * @returns {Buffer} a Buffer view over the same bytes.
 */
function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw zipError(
    'INVALID_ARGUMENT',
    `${label} 必须是 Buffer 或 Uint8Array，实际类型为 ${describeType(value)}`,
  );
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, the checksum used by ZIP entries)
// ---------------------------------------------------------------------------

/** @type {Uint32Array | undefined} lazily built lookup table. */
let crcTable;

/**
 * The standard CRC-32 lookup table (polynomial 0xEDB88320, reflected).
 * @returns {Uint32Array} 256-entry table.
 */
function getCrcTable() {
  if (crcTable !== undefined) return crcTable;
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  crcTable = table;
  return table;
}

/**
 * Extend one CRC-32 register with more bytes. The initial register is
 * `0xffffffff` and the finished checksum is `(register ^ 0xffffffff) >>> 0`, so
 * a streamed payload can be checksummed chunk by chunk without buffering it.
 * @param {number} register - current CRC register.
 * @param {Buffer | Uint8Array} buffer - next bytes.
 * @returns {number} the updated register.
 */
function crcExtend(register, buffer) {
  const table = getCrcTable();
  let crc = register;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = table[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return crc;
}

/**
 * Compute the CRC-32 checksum of a byte sequence.
 * @param {Buffer | Uint8Array} buffer - bytes to checksum.
 * @returns {number} unsigned 32-bit checksum.
 */
export function crc32(buffer) {
  return (crcExtend(0xffffffff, asBuffer(buffer, 'crc32(buffer)')) ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Default decompression guards for one archive.
 *
 * A session archive is a few logs plus the attachment bytes one session
 * referenced, so these bounds sit far above a real backup while still stopping
 * a decompression bomb from exhausting memory: the per-entry and running-total
 * declared sizes are checked against the central directory before anything is
 * inflated, and inflation itself is bounded by the declared entry size.
 */
export const ZIP_READ_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
});

/**
 * Normalize the optional read limits, rejecting nonsense values instead of
 * silently reading with a different bound than the caller asked for.
 * @param {unknown} options - `readZipEntries` options object.
 * @returns {{maxEntries: number, maxEntryBytes: number, maxTotalBytes: number}} resolved limits.
 */
function resolveZipReadLimits(options) {
  const raw = options !== null && typeof options === 'object' ? options : {};
  const limits = {
    maxEntries: raw.maxEntries === undefined ? ZIP_READ_LIMITS.maxEntries : raw.maxEntries,
    maxEntryBytes: raw.maxEntryBytes === undefined ? ZIP_READ_LIMITS.maxEntryBytes : raw.maxEntryBytes,
    maxTotalBytes: raw.maxTotalBytes === undefined ? ZIP_READ_LIMITS.maxTotalBytes : raw.maxTotalBytes,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw zipError(
        'INVALID_ARGUMENT',
        `readZipEntries 的 ${key} 必须是正整数，实际为 ${String(value)}`,
      );
    }
  }
  return limits;
}

/**
 * Locate the end-of-central-directory record. The record is at most
 * 22 + 65535 bytes from the end of the file because an optional archive
 * comment may follow it.
 * @param {Buffer} bytes - complete archive bytes.
 * @returns {number} byte offset of the EOCD signature.
 */
function findEndOfCentralDirectory(bytes) {
  if (bytes.length < END_OF_CENTRAL_DIRECTORY_SIZE) {
    throw zipError(
      'EOCD_NOT_FOUND',
      `不是有效的 ZIP 文件：文件仅 ${bytes.length} 字节，不足以容纳中央目录结束记录（EOCD）`,
    );
  }
  const earliest = Math.max(
    0,
    bytes.length - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_ZIP_COMMENT_SIZE,
  );
  let fallback = -1;
  for (
    let offset = bytes.length - END_OF_CENTRAL_DIRECTORY_SIZE;
    offset >= earliest;
    offset -= 1
  ) {
    if (bytes.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    // A match whose declared comment length fits the file exactly is the real
    // EOCD; random bytes that merely look like the signature do not satisfy it.
    if (offset + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength === bytes.length) {
      return offset;
    }
    if (fallback === -1) fallback = offset;
  }
  if (fallback !== -1) return fallback;
  throw zipError(
    'EOCD_NOT_FOUND',
    '不是有效的 ZIP 文件：未找到中央目录结束记录（EOCD）',
  );
}

/**
 * Read and validate the EOCD fields.
 * @param {Buffer} bytes - complete archive bytes.
 * @param {number} offset - EOCD offset returned by findEndOfCentralDirectory.
 * @returns {{entryCount: number, directoryOffset: number, directorySize: number}} directory locator.
 */
function readEndOfCentralDirectory(bytes, offset) {
  const diskNumber = bytes.readUInt16LE(offset + 4);
  const directoryDisk = bytes.readUInt16LE(offset + 6);
  const entriesOnDisk = bytes.readUInt16LE(offset + 8);
  const entryCount = bytes.readUInt16LE(offset + 10);
  const directorySize = bytes.readUInt32LE(offset + 12);
  const directoryOffset = bytes.readUInt32LE(offset + 16);
  if (
    entryCount === ZIP64_UINT16 ||
    entriesOnDisk === ZIP64_UINT16 ||
    directorySize === ZIP64_UINT32 ||
    directoryOffset === ZIP64_UINT32
  ) {
    throw zipError(
      'ZIP64_UNSUPPORTED',
      '暂不支持 ZIP64 格式的压缩包：请改用标准 ZIP 格式导出（条目数或文件大小超出标准 ZIP 上限）',
    );
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw zipError(
      'MULTI_DISK_UNSUPPORTED',
      '暂不支持分卷 ZIP 压缩包',
    );
  }
  return { entryCount, directoryOffset, directorySize };
}

/**
 * Read one central directory header. All sizes/offsets of the entry are taken
 * from here — never from the local header.
 * @param {Buffer} bytes - complete archive bytes.
 * @param {number} offset - central directory header offset.
 * @param {number} directoryEnd - exclusive end of the central directory.
 * @param {number} index - zero-based entry index, for diagnostics.
 * @returns {{
 *   name: string,
 *   flags: number,
 *   method: number,
 *   compressedSize: number,
 *   uncompressedSize: number,
 *   localHeaderOffset: number,
 *   nextOffset: number,
 * }} parsed header.
 */
function readCentralDirectoryHeader(bytes, offset, directoryEnd, index) {
  if (offset + CENTRAL_DIRECTORY_HEADER_SIZE > directoryEnd) {
    throw zipError(
      'INVALID_CENTRAL_DIRECTORY',
      `ZIP 中央目录损坏：第 ${index + 1} 个条目头超出目录范围（偏移 ${offset}，目录结束于 ${directoryEnd}）`,
    );
  }
  const signature = bytes.readUInt32LE(offset);
  if (signature !== CENTRAL_DIRECTORY_SIGNATURE) {
    throw zipError(
      'INVALID_CENTRAL_DIRECTORY',
      `ZIP 中央目录损坏：第 ${index + 1} 个条目缺少中央目录头签名（偏移 ${offset}）`,
    );
  }
  const flags = bytes.readUInt16LE(offset + 8);
  const method = bytes.readUInt16LE(offset + 10);
  const compressedSize = bytes.readUInt32LE(offset + 20);
  const uncompressedSize = bytes.readUInt32LE(offset + 24);
  const nameLength = bytes.readUInt16LE(offset + 28);
  const extraLength = bytes.readUInt16LE(offset + 30);
  const commentLength = bytes.readUInt16LE(offset + 32);
  const localHeaderOffset = bytes.readUInt32LE(offset + 42);
  if (
    compressedSize === ZIP64_UINT32 ||
    uncompressedSize === ZIP64_UINT32 ||
    localHeaderOffset === ZIP64_UINT32
  ) {
    throw zipError(
      'ZIP64_UNSUPPORTED',
      `暂不支持 ZIP64 格式的压缩包：条目 "${bytes.toString('utf8', offset + CENTRAL_DIRECTORY_HEADER_SIZE, offset + CENTRAL_DIRECTORY_HEADER_SIZE + nameLength)}" 的大小或偏移超出标准 ZIP 上限`,
    );
  }
  const nameStart = offset + CENTRAL_DIRECTORY_HEADER_SIZE;
  const nextOffset = nameStart + nameLength + extraLength + commentLength;
  if (nextOffset > directoryEnd) {
    throw zipError(
      'INVALID_CENTRAL_DIRECTORY',
      `ZIP 中央目录损坏：第 ${index + 1} 个条目的文件名/额外字段越界（偏移 ${offset}）`,
    );
  }
  const name = bytes.toString('utf8', nameStart, nameStart + nameLength);
  return {
    name,
    flags,
    method,
    compressedSize,
    uncompressedSize,
    localHeaderOffset,
    nextOffset,
  };
}

/**
 * Extract and verify one entry's payload using the central directory metadata.
 * @param {Buffer} bytes - complete archive bytes.
 * @param {{name: string, method: number, compressedSize: number, uncompressedSize: number, localHeaderOffset: number}} header - central directory header.
 * @returns {Uint8Array} decompressed entry bytes.
 */
function readEntryData(bytes, header) {
  const { name, method, compressedSize, uncompressedSize, localHeaderOffset } = header;
  if (localHeaderOffset + LOCAL_FILE_HEADER_SIZE > bytes.length) {
    throw zipError(
      'ENTRY_OUT_OF_BOUNDS',
      `ZIP 条目 "${name}" 的本地文件头偏移越界：偏移 ${localHeaderOffset}，文件长度 ${bytes.length} 字节`,
    );
  }
  if (bytes.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw zipError(
      'INVALID_LOCAL_HEADER',
      `ZIP 条目 "${name}" 的本地文件头签名无效（偏移 ${localHeaderOffset}）`,
    );
  }
  // Local name/extra lengths may legitimately differ from the central
  // directory ones, so they are read from the local header itself.
  const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
  const dataStart =
    localHeaderOffset + LOCAL_FILE_HEADER_SIZE + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataStart > bytes.length || dataEnd > bytes.length) {
    throw zipError(
      'ENTRY_OUT_OF_BOUNDS',
      `ZIP 条目 "${name}" 的数据越界：数据范围 ${dataStart}..${dataEnd}，文件长度 ${bytes.length} 字节`,
    );
  }
  const raw = bytes.subarray(dataStart, dataEnd);
  if (method === METHOD_STORE) {
    if (compressedSize !== uncompressedSize) {
      throw zipError(
        'SIZE_MISMATCH',
        `ZIP 条目 "${name}" 的大小不一致：存储法压缩大小 ${compressedSize} 字节，原始大小 ${uncompressedSize} 字节`,
      );
    }
    return new Uint8Array(raw);
  }
  let inflated;
  try {
    // Bound the output by the declared size: a payload that inflates past its
    // central-directory size is corrupt or a decompression bomb, and must fail
    // before the full expansion is allocated. `+ 1` keeps an all-zero declared
    // size from degenerating into "no limit" and lets the exact-size check
    // below stay authoritative for honest archives.
    inflated = inflateRawSync(raw, { maxOutputLength: uncompressedSize + 1 });
  } catch (error) {
    if (error instanceof Error && error.code === 'ERR_BUFFER_TOO_LARGE') {
      throw zipError(
        'SIZE_MISMATCH',
        `ZIP 条目 "${name}" 解压后超过中央目录记录的大小 ${uncompressedSize} 字节，疑似伪造的大小或压缩炸弹`,
        error,
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw zipError('INFLATE_FAILED', `解压 ZIP 条目 "${name}" 失败：${detail}`, error);
  }
  if (inflated.length !== uncompressedSize) {
    throw zipError(
      'SIZE_MISMATCH',
      `ZIP 条目 "${name}" 解压后大小不一致：中央目录记录 ${uncompressedSize} 字节，实际解压出 ${inflated.length} 字节`,
    );
  }
  return new Uint8Array(inflated);
}

/**
 * Read every file entry from a complete ZIP archive.
 *
 * Sizes and payload offsets come from the central directory, so archives whose
 * local headers carry zeros (fflate streaming output with data descriptors) are
 * read correctly. Entry names are decoded as UTF-8; directory entries (empty
 * names or names ending in '/') are skipped; when the same name appears more
 * than once the last occurrence wins.
 *
 * Decompression is bounded by {@link ZIP_READ_LIMITS}: the entry count, each
 * declared uncompressed size, and the running total of declared sizes are
 * checked before inflating, and inflation itself stops at the declared entry
 * size, so a crafted archive cannot expand past the caller's budget.
 *
 * @param {Buffer | Uint8Array} buffer - complete ZIP file bytes.
 * @param {{maxEntries?: number, maxEntryBytes?: number, maxTotalBytes?: number}} [options] - overrides for {@link ZIP_READ_LIMITS}.
 * @returns {Array<{name: string, data: Uint8Array}>} file entries in central-directory order.
 * @throws {Error} with `code` set to one of `EOCD_NOT_FOUND`,
 *   `INVALID_CENTRAL_DIRECTORY`, `ENTRY_OUT_OF_BOUNDS`, `INVALID_LOCAL_HEADER`,
 *   `INFLATE_FAILED`, `SIZE_MISMATCH`, `ENCRYPTED_UNSUPPORTED`,
 *   `UNSUPPORTED_COMPRESSION`, `TOO_MANY_ENTRIES`, `ENTRY_TOO_LARGE`,
 *   `ARCHIVE_TOO_LARGE`, `ZIP64_UNSUPPORTED`, `MULTI_DISK_UNSUPPORTED`,
 *   or `INVALID_ARGUMENT`.
 */
export function readZipEntries(buffer, options = {}) {
  const bytes = asBuffer(buffer, 'readZipEntries(buffer)');
  const limits = resolveZipReadLimits(options);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const { entryCount, directoryOffset, directorySize } = readEndOfCentralDirectory(
    bytes,
    eocdOffset,
  );
  if (entryCount > limits.maxEntries) {
    throw zipError(
      'TOO_MANY_ENTRIES',
      `ZIP 条目数 ${entryCount} 超过上限 ${limits.maxEntries}，疑似压缩炸弹`,
    );
  }
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > bytes.length) {
    throw zipError(
      'INVALID_CENTRAL_DIRECTORY',
      `ZIP 中央目录越界：目录声明范围 ${directoryOffset}..${directoryEnd}，文件长度 ${bytes.length} 字节`,
    );
  }
  /** @type {Map<string, Uint8Array>} later entries override earlier ones. */
  const entries = new Map();
  let declaredTotal = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    const header = readCentralDirectoryHeader(bytes, offset, directoryEnd, index);
    offset = header.nextOffset;
    if (header.name === '' || header.name.endsWith('/')) continue;
    if ((header.flags & FLAG_ENCRYPTED) !== 0) {
      throw zipError(
        'ENCRYPTED_UNSUPPORTED',
        `暂不支持加密的 ZIP 条目："${header.name}"`,
      );
    }
    if (header.method !== METHOD_STORE && header.method !== METHOD_DEFLATE) {
      throw zipError(
        'UNSUPPORTED_COMPRESSION',
        `ZIP 条目 "${header.name}" 使用了不受支持的压缩方法 ${header.method}（仅支持 store=0 / deflate=8）`,
      );
    }
    if (header.uncompressedSize > limits.maxEntryBytes) {
      throw zipError(
        'ENTRY_TOO_LARGE',
        `ZIP 条目 "${header.name}" 解压后大小 ${header.uncompressedSize} 字节超过单条上限 ${limits.maxEntryBytes} 字节，疑似压缩炸弹`,
      );
    }
    declaredTotal += header.uncompressedSize;
    if (declaredTotal > limits.maxTotalBytes) {
      throw zipError(
        'ARCHIVE_TOO_LARGE',
        `ZIP 解压后总大小超过上限 ${limits.maxTotalBytes} 字节（中央目录累计 ${declaredTotal} 字节），疑似压缩炸弹`,
      );
    }
    entries.set(header.name, readEntryData(bytes, header));
  }
  return Array.from(entries, ([name, data]) => ({ name, data }));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Build one local file header (with the name immediately after it).
 * @param {number} method - compression method.
 * @param {number} checksum - CRC-32 of the uncompressed payload.
 * @param {number} compressedSize - payload length in the archive.
 * @param {number} uncompressedSize - original payload length.
 * @param {Buffer} nameBytes - UTF-8 entry name.
 * @param {number} [flags] - general-purpose bit flags (default: UTF-8 name).
 * @returns {Buffer} local file header + name.
 */
function buildLocalFileHeader(
  method,
  checksum,
  compressedSize,
  uncompressedSize,
  nameBytes,
  flags = FLAG_UTF8,
) {
  const header = Buffer.alloc(LOCAL_FILE_HEADER_SIZE + nameBytes.length);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28); // extra field length
  nameBytes.copy(header, LOCAL_FILE_HEADER_SIZE);
  return header;
}

/**
 * Build one central directory header (with the name immediately after it).
 * @param {number} method - compression method.
 * @param {number} checksum - CRC-32 of the uncompressed payload.
 * @param {number} compressedSize - payload length in the archive.
 * @param {number} uncompressedSize - original payload length.
 * @param {Buffer} nameBytes - UTF-8 entry name.
 * @param {number} localHeaderOffset - offset of the local header in the archive.
 * @param {number} [flags] - general-purpose bit flags (default: UTF-8 name).
 * @returns {Buffer} central directory header + name.
 */
function buildCentralDirectoryHeader(
  method,
  checksum,
  compressedSize,
  uncompressedSize,
  nameBytes,
  localHeaderOffset,
  flags = FLAG_UTF8,
) {
  const header = Buffer.alloc(CENTRAL_DIRECTORY_HEADER_SIZE + nameBytes.length);
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_MADE_BY, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(flags, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(uncompressedSize, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30); // extra field length
  header.writeUInt16LE(0, 32); // comment length
  header.writeUInt16LE(0, 34); // disk number start
  header.writeUInt16LE(0, 36); // internal file attributes
  header.writeUInt32LE(0, 38); // external file attributes
  header.writeUInt32LE(localHeaderOffset, 42);
  nameBytes.copy(header, CENTRAL_DIRECTORY_HEADER_SIZE);
  return header;
}

/**
 * Assert a value fits a standard (non-ZIP64) ZIP field.
 * @param {number} value - value to check.
 * @param {number} limit - maximum allowed value (inclusive).
 * @param {string} what - human-readable description.
 */
function assertFitsZip32(value, limit, what) {
  if (value > limit) {
    throw zipError(
      'ZIP64_UNSUPPORTED',
      `无法写出 ZIP64 格式：${what}超出标准 ZIP 上限（${value} > ${limit} 字节）`,
    );
  }
}

/** Normalize the optional writer compression setting. */
function resolveCompression(options) {
  const compression = options === null || options === undefined
    ? 'deflate'
    : options.compression === undefined
      ? 'deflate'
      : options.compression;
  if (compression !== 'deflate' && compression !== 'store') {
    throw zipError(
      'INVALID_ARGUMENT',
      `不支持的 compression 选项 "${String(compression)}"（仅支持 'deflate' 或 'store'）`,
    );
  }
  return compression;
}

/**
 * Build the end-of-central-directory record.
 * @param {number} entryCount - number of file entries.
 * @param {number} directorySize - central directory byte length.
 * @param {number} directoryOffset - central directory byte offset.
 * @returns {Buffer} the 22-byte EOCD.
 */
function buildEndOfCentralDirectory(entryCount, directorySize, directoryOffset) {
  const eocd = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_SIZE);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central directory start disk
  eocd.writeUInt16LE(entryCount, 8); // entries on this disk
  eocd.writeUInt16LE(entryCount, 10); // total entries
  eocd.writeUInt32LE(directorySize, 12);
  eocd.writeUInt32LE(directoryOffset, 16);
  eocd.writeUInt16LE(0, 20); // archive comment length
  return eocd;
}

/**
 * Build the data descriptor that follows a streamed entry's payload (flag bit
 * 3): its sizes were unknown when the local header was written.
 * @param {number} checksum - CRC-32 of the uncompressed payload.
 * @param {number} compressedSize - payload length in the archive.
 * @param {number} uncompressedSize - original payload length.
 * @returns {Buffer} 16-byte descriptor with the optional signature.
 */
function buildDataDescriptor(checksum, compressedSize, uncompressedSize) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
  descriptor.writeUInt32LE(checksum, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);
  return descriptor;
}

/** True for values that produce their bytes asynchronously (streams, generators). */
function isAsyncIterable(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Yield one payload in bite-sized chunks so the sink can apply backpressure to
 * a large in-memory entry.
 * @param {Buffer} payload - complete payload bytes.
 * @returns {Generator<Buffer>} chunks.
 */
function* payloadChunks(payload) {
  for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
    yield payload.subarray(offset, Math.min(offset + 64 * 1024, payload.length));
  }
}

/**
 * Write a standard ZIP archive from in-memory entries.
 *
 * Entry names are UTF-8 and stored verbatim (no path normalization or
 * validation), so names containing ':' are preserved inside the archive.
 * Payloads use deflate by default; `{ compression: 'store' }` disables
 * compression. ZIP64 limits are enforced with readable errors instead of
 * silently producing a corrupt archive.
 *
 * @param {Array<{name: string, data: Buffer | Uint8Array}>} entries - files to write, in order.
 * @param {{compression?: 'deflate' | 'store'}} [options] - writer options.
 * @returns {Buffer} complete ZIP file bytes.
 * @throws {Error} with `code` set to `INVALID_ARGUMENT` or `ZIP64_UNSUPPORTED`.
 */
export function writeZipEntries(entries, options = {}) {
  if (!Array.isArray(entries)) {
    throw zipError(
      'INVALID_ARGUMENT',
      `writeZipEntries(entries) 需要条目数组，实际类型为 ${describeType(entries)}`,
    );
  }
  const compression = resolveCompression(options);
  const method = compression === 'store' ? METHOD_STORE : METHOD_DEFLATE;
  /** @type {Buffer[]} */
  const localChunks = [];
  /** @type {Buffer[]} */
  const centralChunks = [];
  let localOffset = 0;
  let directorySize = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === null || typeof entry !== 'object') {
      throw zipError(
        'INVALID_ARGUMENT',
        `writeZipEntries(entries[${index}]) 必须是 { name, data } 对象，实际类型为 ${describeType(entry)}`,
      );
    }
    const { name } = entry;
    if (typeof name !== 'string' || name === '') {
      throw zipError(
        'INVALID_ARGUMENT',
        `writeZipEntries(entries[${index}].name) 必须是非空字符串`,
      );
    }
    const nameBytes = Buffer.from(name, 'utf8');
    assertFitsZip32(nameBytes.length, 0xffff, `条目名 "${name}" 的长度`);
    const data = asBuffer(entry.data, `writeZipEntries(entries[${index}].data)`);
    assertFitsZip32(data.length, ZIP64_UINT32, `条目 "${name}" 的原始大小`);
    const checksum = crc32(data);
    const payload = method === METHOD_DEFLATE ? deflateRawSync(data) : data;
    assertFitsZip32(payload.length, ZIP64_UINT32, `条目 "${name}" 的压缩大小`);
    assertFitsZip32(localOffset, ZIP64_UINT32, `条目 "${name}" 的本地头偏移`);
    localChunks.push(
      buildLocalFileHeader(method, checksum, payload.length, data.length, nameBytes),
      payload,
    );
    centralChunks.push(
      buildCentralDirectoryHeader(
        method,
        checksum,
        payload.length,
        data.length,
        nameBytes,
        localOffset,
      ),
    );
    localOffset += LOCAL_FILE_HEADER_SIZE + nameBytes.length + payload.length;
    directorySize += CENTRAL_DIRECTORY_HEADER_SIZE + nameBytes.length;
    assertFitsZip32(localOffset, ZIP64_UINT32, 'ZIP 文件总大小');
    assertFitsZip32(directorySize, ZIP64_UINT32, 'ZIP 中央目录大小');
  }
  if (entries.length > ZIP64_UINT16) {
    throw zipError(
      'ZIP64_UNSUPPORTED',
      `无法写出 ZIP64 格式：条目数 ${entries.length} 超过标准 ZIP 上限 ${ZIP64_UINT16}`,
    );
  }
  return Buffer.concat([
    ...localChunks,
    ...centralChunks,
    buildEndOfCentralDirectory(entries.length, directorySize, localOffset),
  ]);
}

/**
 * Write a ZIP archive incrementally to an async sink.
 *
 * Unlike `writeZipEntries`, which materializes the whole archive and returns it,
 * this producer hands each entry's local header and payload to the sink before
 * reading the next entry: the caller never holds the archive in memory, and the
 * promise returned by the sink applies backpressure to the producer (a slow
 * file write or client socket slows the export down instead of growing a
 * buffer).
 *
 * Entry data is either a complete `Buffer` / `Uint8Array` (sizes known up front
 * — written exactly as `writeZipEntries` writes them) or an async iterable of
 * chunks (bytes being streamed from disk). Streamed entries use a data
 * descriptor: the local header carries zero sizes plus flag bit 3, and the
 * authoritative sizes/CRC follow the payload and are recorded in the central
 * directory. That is the same shape the shipped session-log export produces,
 * so both this module's reader and ordinary ZIP tools accept the archive.
 *
 * The returned promise rejects with the underlying error when the sink rejects
 * or an input iterable throws; the archive is incomplete in that case and the
 * caller owns cleanup (e.g. deleting a partially written file).
 *
 * @param {Iterable<object> | AsyncIterable<object>} entries - `{ name, data }` entries in archive order.
 * @param {(chunk: Buffer) => void | Promise<void>} sink - receives archive bytes in order; return a promise that settles when more can be accepted.
 * @param {{compression?: 'deflate' | 'store'}} [options] - writer options.
 * @returns {Promise<{entryCount: number, bytesWritten: number}>} entry count and total archive bytes.
 * @throws {Error} with `code` set to `INVALID_ARGUMENT` or `ZIP64_UNSUPPORTED`.
 */
export async function streamZipEntries(entries, sink, options = {}) {
  if (typeof sink !== 'function') {
    throw zipError('INVALID_ARGUMENT', 'streamZipEntries(entries, sink) 需要一个接收字节的回调');
  }
  const isIterable =
    entries !== null &&
    typeof entries === 'object' &&
    (typeof entries[Symbol.iterator] === 'function' || typeof entries[Symbol.asyncIterator] === 'function');
  if (!isIterable) {
    throw zipError(
      'INVALID_ARGUMENT',
      `streamZipEntries(entries) 需要条目数组或可迭代对象，实际类型为 ${describeType(entries)}`,
    );
  }
  const compression = resolveCompression(options);
  const method = compression === 'store' ? METHOD_STORE : METHOD_DEFLATE;
  /** @type {Buffer[]} */
  const centralChunks = [];
  let localOffset = 0;
  let directorySize = 0;
  let entryCount = 0;
  let bytesWritten = 0;
  const write = async (chunk) => {
    bytesWritten += chunk.length;
    await sink(chunk);
  };

  for await (const entry of entries) {
    const index = entryCount;
    if (entry === null || typeof entry !== 'object') {
      throw zipError(
        'INVALID_ARGUMENT',
        `streamZipEntries(entries[${index}]) 必须是 { name, data } 对象，实际类型为 ${describeType(entry)}`,
      );
    }
    const { name } = entry;
    if (typeof name !== 'string' || name === '') {
      throw zipError('INVALID_ARGUMENT', `streamZipEntries(entries[${index}].name) 必须是非空字符串`);
    }
    const nameBytes = Buffer.from(name, 'utf8');
    assertFitsZip32(nameBytes.length, 0xffff, `条目名 "${name}" 的长度`);
    const data = entry.data;
    let flags = FLAG_UTF8;
    let checksum;
    let compressedSize;
    let uncompressedSize;

    if (isAsyncIterable(data)) {
      flags = FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
      assertFitsZip32(localOffset, ZIP64_UINT32, `条目 "${name}" 的本地头偏移`);
      await write(buildLocalFileHeader(method, 0, 0, 0, nameBytes, flags));
      let register = 0xffffffff;
      let uncompressed = 0;
      let compressed = 0;
      const measured = async function* measuredBytes() {
        for await (const chunk of data) {
          const bytes = asBuffer(chunk, `streamZipEntries(entries[${index}].data)`);
          register = crcExtend(register, bytes);
          uncompressed += bytes.length;
          yield bytes;
        }
      };
      if (method === METHOD_STORE) {
        for await (const chunk of measured()) {
          compressed += chunk.length;
          await write(chunk);
        }
      } else {
        await pipeline(
          Readable.from(measured()),
          createDeflateRaw(),
          new Writable({
            write(chunk, _encoding, callback) {
              compressed += chunk.length;
              write(chunk).then(() => callback(), callback);
            },
          }),
        );
      }
      checksum = (register ^ 0xffffffff) >>> 0;
      compressedSize = compressed;
      uncompressedSize = uncompressed;
      assertFitsZip32(compressedSize, ZIP64_UINT32, `条目 "${name}" 的压缩大小`);
      assertFitsZip32(uncompressedSize, ZIP64_UINT32, `条目 "${name}" 的原始大小`);
      await write(buildDataDescriptor(checksum, compressedSize, uncompressedSize));
    } else {
      const bytes = asBuffer(data, `streamZipEntries(entries[${index}].data)`);
      assertFitsZip32(bytes.length, ZIP64_UINT32, `条目 "${name}" 的原始大小`);
      checksum = crc32(bytes);
      const payload = method === METHOD_DEFLATE ? deflateRawSync(bytes) : bytes;
      assertFitsZip32(payload.length, ZIP64_UINT32, `条目 "${name}" 的压缩大小`);
      assertFitsZip32(localOffset, ZIP64_UINT32, `条目 "${name}" 的本地头偏移`);
      compressedSize = payload.length;
      uncompressedSize = bytes.length;
      await write(buildLocalFileHeader(method, checksum, compressedSize, uncompressedSize, nameBytes, flags));
      for (const chunk of payloadChunks(payload)) await write(chunk);
    }

    centralChunks.push(
      buildCentralDirectoryHeader(
        method,
        checksum,
        compressedSize,
        uncompressedSize,
        nameBytes,
        localOffset,
        flags,
      ),
    );
    localOffset +=
      LOCAL_FILE_HEADER_SIZE +
      nameBytes.length +
      compressedSize +
      ((flags & FLAG_DATA_DESCRIPTOR) !== 0 ? 16 : 0);
    directorySize += CENTRAL_DIRECTORY_HEADER_SIZE + nameBytes.length;
    entryCount += 1;
    assertFitsZip32(localOffset, ZIP64_UINT32, 'ZIP 文件总大小');
    assertFitsZip32(directorySize, ZIP64_UINT32, 'ZIP 中央目录大小');
  }

  if (entryCount > ZIP64_UINT16) {
    throw zipError(
      'ZIP64_UNSUPPORTED',
      `无法写出 ZIP64 格式：条目数 ${entryCount} 超过标准 ZIP 上限 ${ZIP64_UINT16}`,
    );
  }
  for (const chunk of centralChunks) await write(chunk);
  await write(buildEndOfCentralDirectory(entryCount, directorySize, localOffset));
  return { entryCount, bytesWritten };
}
