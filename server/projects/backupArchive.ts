import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, createInflateRaw } from 'node:zlib';
import {
  BACKUP_MAX_META_ENTRY_BYTES,
  BACKUP_MAX_TOTAL_UNCOMPRESSED_BYTES,
  validateBackupEntryPath,
} from '../../shared/backup';
import { HostRpcError } from '../../shared/errors';

const LFH_SIG = 0x04034b50;
const CDH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const UNIX_SYMLINK_TYPE = 0o120000;
const UNIX_FILE_TYPE_MASK = 0o170000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < chunk.length; i++) {
    c = CRC_TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface WrittenBackupEntry {
  path: string;
  method: 'store' | 'deflate';
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  sha256: string;
  localHeaderOffset: number;
}

export interface BackupArchiveWriterOptions {
  /** Override 32-bit threshold in tests to exercise ZIP64 headers without 4 GiB fixtures. */
  zip64Threshold?: number;
}

function backupInvalid(message: string, reason: string): HostRpcError {
  return new HostRpcError('BACKUP_INVALID', message, { reason });
}

export class BackupZipWriter {
  private handle: FileHandle | undefined;
  private offset = 0;
  private entries: WrittenBackupEntry[] = [];
  private finalized = false;
  private readonly zip64Threshold: number;

  private constructor(handle: FileHandle, options: BackupArchiveWriterOptions = {}) {
    this.handle = handle;
    this.zip64Threshold = options.zip64Threshold ?? UINT32_MAX;
  }

  static async open(filePath: string, options?: BackupArchiveWriterOptions): Promise<BackupZipWriter> {
    const handle = await open(filePath, 'w+');
    return new BackupZipWriter(handle, options);
  }

  private async writeAt(buffer: Buffer, position: number): Promise<void> {
    if (!this.handle) throw new Error('BackupZipWriter is closed');
    let written = 0;
    while (written < buffer.length) {
      const res = await this.handle.write(buffer, written, buffer.length - written, position + written);
      written += res.bytesWritten;
    }
  }

  private async appendBuffer(buffer: Buffer): Promise<void> {
    await this.writeAt(buffer, this.offset);
    this.offset += buffer.length;
  }

  async addBuffer(entryPath: string, bytes: Buffer, method: 'store' | 'deflate' = 'deflate', signal?: AbortSignal): Promise<WrittenBackupEntry> {
    return this.addStream(entryPath, async function* () { yield bytes; }(), method, {
      knownUncompressedSize: bytes.length,
      signal,
    });
  }

  async addFile(
    entryPath: string,
    filePath: string,
    method: 'store' | 'deflate' = 'store',
    options: { knownUncompressedSize?: number; signal?: AbortSignal; onBytes?: (bytes: number) => void } = {},
  ): Promise<WrittenBackupEntry> {
    const stream = createReadStream(filePath);
    return this.addStream(entryPath, stream, method, options);
  }

  async addStream(
    entryPath: string,
    source: NodeJS.ReadableStream | AsyncIterable<Buffer>,
    method: 'store' | 'deflate' = 'store',
    options: { knownUncompressedSize?: number; signal?: AbortSignal; onBytes?: (bytes: number) => void } = {},
  ): Promise<WrittenBackupEntry> {
    if (this.finalized || !this.handle) throw new Error('BackupZipWriter already finalized or closed');
    const check = validateBackupEntryPath(entryPath);
    if (!check.ok) throw new Error(check.reason);
    if (this.entries.some((e) => e.path === entryPath)) {
      throw new Error(`Duplicate archive entry: ${entryPath}`);
    }

    const nameBytes = Buffer.from(entryPath, 'utf8');
    const useZip64Lfh =
      this.offset >= this.zip64Threshold ||
      (options.knownUncompressedSize !== undefined && options.knownUncompressedSize >= this.zip64Threshold);
    const extraLen = useZip64Lfh ? 20 : 0;
    const localHeaderOffset = this.offset;

    const placeholderLfh = Buffer.alloc(30 + nameBytes.length + extraLen);
    placeholderLfh.writeUInt32LE(LFH_SIG, 0);
    placeholderLfh.writeUInt16LE(useZip64Lfh ? 45 : 20, 4);
    placeholderLfh.writeUInt16LE(UTF8_FLAG, 6);
    placeholderLfh.writeUInt16LE(method === 'deflate' ? METHOD_DEFLATE : METHOD_STORE, 8);
    nameBytes.copy(placeholderLfh, 30);
    await this.appendBuffer(placeholderLfh);

    const sha256Hash = createHash('sha256');
    let crc = 0;
    let uncompressedSize = 0;
    let compressedSize = 0;

    const handle = this.handle;
    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const position = this.offset;
        this.offset += chunk.length;
        compressedSize += chunk.length;
        handle
          .write(chunk, 0, chunk.length, position)
          .then(() => callback())
          .catch((err) => callback(err instanceof Error ? err : new Error(String(err))));
      },
    });

    const hashTransform = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        if (options.signal?.aborted) {
          callback(new Error('Job cancelled'));
          return;
        }
        uncompressedSize += chunk.length;
        crc = crc32Update(crc, chunk);
        sha256Hash.update(chunk);
        options.onBytes?.(chunk.length);
        callback(null, chunk);
      },
    });

    const stages: Array<NodeJS.ReadableStream | NodeJS.ReadWriteStream | NodeJS.WritableStream> = [
      source as NodeJS.ReadableStream,
      hashTransform,
    ];
    if (method === 'deflate') {
      stages.push(createDeflateRaw({ level: 6 }));
    }
    stages.push(sink);
    await pipeline(stages as [NodeJS.ReadableStream, ...NodeJS.ReadWriteStream[], NodeJS.WritableStream], {
      signal: options.signal,
    });

    if (!useZip64Lfh && (uncompressedSize >= this.zip64Threshold || compressedSize >= this.zip64Threshold)) {
      throw new Error(`Entry ${entryPath} exceeded 32-bit ZIP limit without ZIP64 header reservation`);
    }

    const lfh = Buffer.alloc(30 + nameBytes.length + extraLen);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(useZip64Lfh ? 45 : 20, 4);
    lfh.writeUInt16LE(UTF8_FLAG, 6);
    lfh.writeUInt16LE(method === 'deflate' ? METHOD_DEFLATE : METHOD_STORE, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc >>> 0, 14);
    lfh.writeUInt32LE(useZip64Lfh ? UINT32_MAX : compressedSize, 18);
    lfh.writeUInt32LE(useZip64Lfh ? UINT32_MAX : uncompressedSize, 22);
    lfh.writeUInt16LE(nameBytes.length, 26);
    lfh.writeUInt16LE(extraLen, 28);
    nameBytes.copy(lfh, 30);
    if (useZip64Lfh) {
      const extraOffset = 30 + nameBytes.length;
      lfh.writeUInt16LE(ZIP64_EXTRA_ID, extraOffset);
      lfh.writeUInt16LE(16, extraOffset + 2);
      lfh.writeBigUInt64LE(BigInt(uncompressedSize), extraOffset + 4);
      lfh.writeBigUInt64LE(BigInt(compressedSize), extraOffset + 12);
    }
    await this.writeAt(lfh, localHeaderOffset);

    const record: WrittenBackupEntry = {
      path: entryPath,
      method,
      crc32: crc >>> 0,
      compressedSize,
      uncompressedSize,
      sha256: sha256Hash.digest('hex'),
      localHeaderOffset,
    };
    this.entries.push(record);
    return record;
  }

  async finalize(): Promise<WrittenBackupEntry[]> {
    if (this.finalized) return this.entries;
    if (!this.handle) throw new Error('BackupZipWriter is closed');
    this.finalized = true;

    const cdOffset = this.offset;
    let needsZip64Eocd = this.entries.length >= UINT16_MAX || cdOffset >= this.zip64Threshold;

    for (const entry of this.entries) {
      const nameBytes = Buffer.from(entry.path, 'utf8');
      const needU = entry.uncompressedSize >= this.zip64Threshold;
      const needC = entry.compressedSize >= this.zip64Threshold;
      const needO = entry.localHeaderOffset >= this.zip64Threshold;
      const extraFieldsCount = (needU ? 1 : 0) + (needC ? 1 : 0) + (needO ? 1 : 0);
      if (extraFieldsCount > 0) needsZip64Eocd = true;
      const extraDataSize = extraFieldsCount * 8;
      const extraLen = extraDataSize > 0 ? 4 + extraDataSize : 0;

      const cdh = Buffer.alloc(46 + nameBytes.length + extraLen);
      cdh.writeUInt32LE(CDH_SIG, 0);
      cdh.writeUInt16LE(45, 4); // version made by: Unix/4.5
      cdh.writeUInt16LE(extraLen > 0 ? 45 : 20, 6);
      cdh.writeUInt16LE(UTF8_FLAG, 8);
      cdh.writeUInt16LE(entry.method === 'deflate' ? METHOD_DEFLATE : METHOD_STORE, 10);
      cdh.writeUInt16LE(0, 12);
      cdh.writeUInt16LE(0, 14);
      cdh.writeUInt32LE(entry.crc32 >>> 0, 16);
      cdh.writeUInt32LE(needC ? UINT32_MAX : entry.compressedSize, 20);
      cdh.writeUInt32LE(needU ? UINT32_MAX : entry.uncompressedSize, 24);
      cdh.writeUInt16LE(nameBytes.length, 28);
      cdh.writeUInt16LE(extraLen, 30);
      cdh.writeUInt16LE(0, 32); // comment len
      cdh.writeUInt16LE(0, 34); // disk start
      cdh.writeUInt16LE(0, 36); // internal attrs
      cdh.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file external attrs
      cdh.writeUInt32LE(needO ? UINT32_MAX : entry.localHeaderOffset, 42);
      nameBytes.copy(cdh, 46);

      if (extraLen > 0) {
        let pos = 46 + nameBytes.length;
        cdh.writeUInt16LE(ZIP64_EXTRA_ID, pos);
        cdh.writeUInt16LE(extraDataSize, pos + 2);
        pos += 4;
        if (needU) {
          cdh.writeBigUInt64LE(BigInt(entry.uncompressedSize), pos);
          pos += 8;
        }
        if (needC) {
          cdh.writeBigUInt64LE(BigInt(entry.compressedSize), pos);
          pos += 8;
        }
        if (needO) {
          cdh.writeBigUInt64LE(BigInt(entry.localHeaderOffset), pos);
        }
      }
      await this.appendBuffer(cdh);
    }

    const cdSize = this.offset - cdOffset;
    if (cdSize >= this.zip64Threshold) needsZip64Eocd = true;

    if (needsZip64Eocd) {
      const zip64EocdOffset = this.offset;
      const z64 = Buffer.alloc(56);
      z64.writeUInt32LE(ZIP64_EOCD_SIG, 0);
      z64.writeBigUInt64LE(44n, 4);
      z64.writeUInt16LE(45, 12);
      z64.writeUInt16LE(45, 14);
      z64.writeUInt32LE(0, 16);
      z64.writeUInt32LE(0, 20);
      z64.writeBigUInt64LE(BigInt(this.entries.length), 24);
      z64.writeBigUInt64LE(BigInt(this.entries.length), 32);
      z64.writeBigUInt64LE(BigInt(cdSize), 40);
      z64.writeBigUInt64LE(BigInt(cdOffset), 48);
      await this.appendBuffer(z64);

      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
      loc.writeUInt32LE(1, 16);
      await this.appendBuffer(loc);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length >= UINT16_MAX ? UINT16_MAX : this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length >= UINT16_MAX ? UINT16_MAX : this.entries.length, 10);
    eocd.writeUInt32LE(cdSize >= this.zip64Threshold ? UINT32_MAX : cdSize, 12);
    eocd.writeUInt32LE(cdOffset >= this.zip64Threshold ? UINT32_MAX : cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await this.appendBuffer(eocd);
    await this.close();
    return this.entries;
  }

  async close(): Promise<void> {
    if (!this.handle) return;
    const h = this.handle;
    this.handle = undefined;
    await h.close();
  }
}

export interface ParsedBackupZipEntry {
  path: string;
  compressionMethod: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttributes: number;
}

export class BackupZipReader {
  private handle: FileHandle | undefined;
  readonly fileSize: number;
  readonly entries: Map<string, ParsedBackupZipEntry>;
  readonly totalUncompressedBytes: number;
  private readonly filePath: string;

  private constructor(
    filePath: string,
    handle: FileHandle,
    fileSize: number,
    entries: Map<string, ParsedBackupZipEntry>,
    totalUncompressedBytes: number,
  ) {
    this.filePath = filePath;
    this.handle = handle;
    this.fileSize = fileSize;
    this.entries = entries;
    this.totalUncompressedBytes = totalUncompressedBytes;
  }

  private static async readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const res = await handle.read(buf, offset, length - offset, position + offset);
      if (res.bytesRead === 0) {
        throw backupInvalid('归档文件已截断或损坏', 'CORRUPT_ARCHIVE');
      }
      offset += res.bytesRead;
    }
    return buf;
  }

  static async open(filePath: string): Promise<BackupZipReader> {
    const handle = await open(filePath, 'r');
    try {
      const statInfo = await handle.stat();
      const fileSize = statInfo.size;
      if (fileSize < 22) {
        throw backupInvalid('文件过小，不是有效的项目备份归档', 'CORRUPT_ARCHIVE');
      }

      const tailSize = Math.min(fileSize, 65_557);
      const tailOffset = fileSize - tailSize;
      const tail = await BackupZipReader.readExact(handle, tailOffset, tailSize);

      let eocdInTail = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD_SIG) {
          const commentLen = tail.readUInt16LE(i + 20);
          if (i + 22 + commentLen === tail.length) {
            eocdInTail = i;
            break;
          }
        }
      }
      if (eocdInTail < 0) {
        throw backupInvalid('找不到 ZIP 结尾目录（归档损坏或不是 ZIP 文件）', 'CORRUPT_ARCHIVE');
      }

      const diskNum = tail.readUInt16LE(eocdInTail + 4);
      const cdStartDisk = tail.readUInt16LE(eocdInTail + 6);
      if (diskNum !== 0 || cdStartDisk !== 0) {
        throw backupInvalid('不支持分卷 ZIP 归档', 'CORRUPT_ARCHIVE');
      }

      let entryCount = tail.readUInt16LE(eocdInTail + 10);
      let cdSize = tail.readUInt32LE(eocdInTail + 12);
      let cdOffset = tail.readUInt32LE(eocdInTail + 16);
      const eocdAbsOffset = tailOffset + eocdInTail;

      if (eocdAbsOffset >= 20) {
        const locatorOffset = eocdAbsOffset - 20;
        const locator = await BackupZipReader.readExact(handle, locatorOffset, 20);
        if (locator.readUInt32LE(0) === ZIP64_LOCATOR_SIG) {
          const z64Offset = Number(locator.readBigUInt64LE(8));
          if (!Number.isSafeInteger(z64Offset) || z64Offset < 0 || z64Offset + 56 > locatorOffset) {
            throw backupInvalid('ZIP64 目录定位信息损坏', 'CORRUPT_ARCHIVE');
          }
          const z64 = await BackupZipReader.readExact(handle, z64Offset, 56);
          if (z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
            throw backupInvalid('ZIP64 结尾目录签名无效', 'CORRUPT_ARCHIVE');
          }
          const totalEntries64 = Number(z64.readBigUInt64LE(32));
          const cdSize64 = Number(z64.readBigUInt64LE(40));
          const cdOffset64 = Number(z64.readBigUInt64LE(48));
          if (!Number.isSafeInteger(totalEntries64) || !Number.isSafeInteger(cdSize64) || !Number.isSafeInteger(cdOffset64)) {
            throw backupInvalid('ZIP64 偏移量超出安全范围', 'CORRUPT_ARCHIVE');
          }
          entryCount = totalEntries64;
          cdSize = cdSize64;
          cdOffset = cdOffset64;
        }
      }

      if (cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > eocdAbsOffset) {
        throw backupInvalid('ZIP 中央目录范围越界或损坏', 'CORRUPT_ARCHIVE');
      }

      const cdBuf = await BackupZipReader.readExact(handle, cdOffset, cdSize);
      const entries = new Map<string, ParsedBackupZipEntry>();
      let cursor = 0;
      let totalUncompressedBytes = 0;

      for (let idx = 0; idx < entryCount; idx++) {
        if (cursor + 46 > cdBuf.length || cdBuf.readUInt32LE(cursor) !== CDH_SIG) {
          throw backupInvalid('ZIP 中央目录条目损坏', 'CORRUPT_ARCHIVE');
        }
        const versionMadeBy = cdBuf.readUInt16LE(cursor + 4);
        const flags = cdBuf.readUInt16LE(cursor + 8);
        const method = cdBuf.readUInt16LE(cursor + 10);
        const crc32 = cdBuf.readUInt32LE(cursor + 16);
        let compressedSize = cdBuf.readUInt32LE(cursor + 20);
        let uncompressedSize = cdBuf.readUInt32LE(cursor + 24);
        const nameLen = cdBuf.readUInt16LE(cursor + 28);
        const extraLen = cdBuf.readUInt16LE(cursor + 30);
        const commentLen = cdBuf.readUInt16LE(cursor + 32);
        const externalAttributes = cdBuf.readUInt32LE(cursor + 38);
        let localHeaderOffset = cdBuf.readUInt32LE(cursor + 42);

        const headerEnd = cursor + 46 + nameLen + extraLen + commentLen;
        if (headerEnd > cdBuf.length) {
          throw backupInvalid('ZIP 中央目录条目长度越界', 'CORRUPT_ARCHIVE');
        }

        if ((flags & 0x0001) !== 0) {
          throw backupInvalid('不支持加密的项目备份归档', 'CORRUPT_ARCHIVE');
        }
        if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
          throw backupInvalid(`不支持的压缩方式: ${method}`, 'CORRUPT_ARCHIVE');
        }

        const name = cdBuf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
        const pathCheck = validateBackupEntryPath(name);
        if (!pathCheck.ok) {
          throw backupInvalid(`归档包含非法路径：${name}`, 'UNSAFE_PATH');
        }
        if (entries.has(name)) {
          throw backupInvalid(`归档包含重复条目：${name}`, 'CORRUPT_ARCHIVE');
        }

        const madeByOs = versionMadeBy >>> 8;
        const unixMode = (externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
        if ((madeByOs === 3 || unixMode !== 0) && unixMode === UNIX_SYMLINK_TYPE) {
          throw backupInvalid(`归档包含不安全的符号链接条目：${name}`, 'UNSAFE_PATH');
        }

        const extraBuf = cdBuf.subarray(cursor + 46 + nameLen, cursor + 46 + nameLen + extraLen);
        let ex = 0;
        while (ex + 4 <= extraBuf.length) {
          const id = extraBuf.readUInt16LE(ex);
          const size = extraBuf.readUInt16LE(ex + 2);
          if (ex + 4 + size > extraBuf.length) {
            throw backupInvalid('ZIP 扩展字段损坏', 'CORRUPT_ARCHIVE');
          }
          if (id === ZIP64_EXTRA_ID) {
            let zPos = ex + 4;
            if (uncompressedSize === UINT32_MAX && zPos + 8 <= ex + 4 + size) {
              uncompressedSize = Number(extraBuf.readBigUInt64LE(zPos));
              zPos += 8;
            }
            if (compressedSize === UINT32_MAX && zPos + 8 <= ex + 4 + size) {
              compressedSize = Number(extraBuf.readBigUInt64LE(zPos));
              zPos += 8;
            }
            if (localHeaderOffset === UINT32_MAX && zPos + 8 <= ex + 4 + size) {
              localHeaderOffset = Number(extraBuf.readBigUInt64LE(zPos));
            }
          }
          ex += 4 + size;
        }

        if (
          !Number.isSafeInteger(compressedSize) ||
          !Number.isSafeInteger(uncompressedSize) ||
          !Number.isSafeInteger(localHeaderOffset) ||
          localHeaderOffset < 0 ||
          localHeaderOffset + 30 > cdOffset
        ) {
          throw backupInvalid(`归档条目偏移量损坏：${name}`, 'CORRUPT_ARCHIVE');
        }
        if (method === METHOD_STORE && compressedSize !== uncompressedSize) {
          throw backupInvalid(`STORE 条目大小不一致：${name}`, 'CORRUPT_ARCHIVE');
        }
        const isMeta = name.endsWith('.json');
        if (isMeta && uncompressedSize > BACKUP_MAX_META_ENTRY_BYTES) {
          throw backupInvalid(`元数据条目过大：${name}`, 'CORRUPT_ARCHIVE');
        }
        totalUncompressedBytes += uncompressedSize;
        if (totalUncompressedBytes > BACKUP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
          throw backupInvalid('归档声明体积超出安全上限', 'CORRUPT_ARCHIVE');
        }

        entries.set(name, {
          path: name,
          compressionMethod: method,
          flags,
          crc32,
          compressedSize,
          uncompressedSize,
          localHeaderOffset,
          externalAttributes,
        });
        cursor = headerEnd;
      }

      if (cursor !== cdBuf.length) {
        throw backupInvalid('ZIP 中央目录长度不匹配', 'CORRUPT_ARCHIVE');
      }

      return new BackupZipReader(filePath, handle, fileSize, entries, totalUncompressedBytes);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async dataOffsetFor(entry: ParsedBackupZipEntry): Promise<number> {
    if (!this.handle) throw new Error('BackupZipReader is closed');
    const lfh = await BackupZipReader.readExact(this.handle, entry.localHeaderOffset, 30);
    if (lfh.readUInt32LE(0) !== LFH_SIG) {
      throw backupInvalid(`无效的本地文件头：${entry.path}`, 'CORRUPT_ARCHIVE');
    }
    const lfhNameLen = lfh.readUInt16LE(26);
    const lfhExtraLen = lfh.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    if (dataOffset + entry.compressedSize > this.fileSize) {
      throw backupInvalid(`条目数据越界或文件被截断：${entry.path}`, 'CORRUPT_ARCHIVE');
    }
    return dataOffset;
  }

  async readBuffer(entryPath: string, maxBytes = BACKUP_MAX_META_ENTRY_BYTES, signal?: AbortSignal): Promise<{ buffer: Buffer; sha256: string }> {
    const entry = this.entries.get(entryPath);
    if (!entry) throw backupInvalid(`缺少必需的归档条目：${entryPath}`, 'CORRUPT_ARCHIVE');
    if (entry.uncompressedSize > maxBytes) {
      throw backupInvalid(`条目体积超出读取上限：${entryPath}`, 'CORRUPT_ARCHIVE');
    }
    const chunks: Buffer[] = [];
    const { sha256 } = await this.streamEntry(entryPath, new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    }), signal);
    return { buffer: Buffer.concat(chunks), sha256 };
  }

  async streamEntry(
    entryPath: string,
    destination: NodeJS.WritableStream,
    signal?: AbortSignal,
    onBytes?: (bytes: number) => void,
  ): Promise<{ size: number; crc32: number; sha256: string }> {
    const entry = this.entries.get(entryPath);
    if (!entry) throw backupInvalid(`缺少归档条目：${entryPath}`, 'CORRUPT_ARCHIVE');
    const dataOffset = await this.dataOffsetFor(entry);
    const rawStream = entry.compressedSize === 0
      ? async function* () { /* empty */ }()
      : createReadStream(this.filePath, {
          start: dataOffset,
          end: dataOffset + entry.compressedSize - 1,
        });

    const sha256Hash = createHash('sha256');
    let crc = 0;
    let actualSize = 0;

    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (signal?.aborted) {
          callback(new Error('Job cancelled'));
          return;
        }
        actualSize += chunk.length;
        if (actualSize > entry.uncompressedSize) {
          callback(backupInvalid(`条目解压体积超出声明上限：${entryPath}`, 'CORRUPT_ARCHIVE'));
          return;
        }
        crc = crc32Update(crc, chunk);
        sha256Hash.update(chunk);
        onBytes?.(chunk.length);
        callback(null, chunk);
      },
    });

    try {
      if (entry.compressionMethod === METHOD_DEFLATE) {
        await pipeline(rawStream as NodeJS.ReadableStream, createInflateRaw(), verifier, destination, { signal });
      } else {
        await pipeline(rawStream as NodeJS.ReadableStream, verifier, destination, { signal });
      }
    } catch (error) {
      if (error instanceof HostRpcError) throw error;
      if (signal?.aborted) throw error;
      throw backupInvalid(`读取归档条目失败（${entryPath}）：${error instanceof Error ? error.message : String(error)}`, 'CORRUPT_ARCHIVE');
    }

    if (actualSize !== entry.uncompressedSize) {
      throw backupInvalid(`条目体积与目录不匹配：${entryPath}`, 'INTEGRITY_MISMATCH');
    }
    if ((crc >>> 0) !== (entry.crc32 >>> 0)) {
      throw backupInvalid(`条目 CRC32 校验失败：${entryPath}`, 'INTEGRITY_MISMATCH');
    }
    return { size: actualSize, crc32: crc >>> 0, sha256: sha256Hash.digest('hex') };
  }

  async verifyEntry(entryPath: string, expectedSha256?: string, signal?: AbortSignal, onBytes?: (bytes: number) => void): Promise<{ size: number; sha256: string }> {
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const result = await this.streamEntry(entryPath, sink, signal, onBytes);
    if (expectedSha256 && result.sha256 !== expectedSha256) {
      throw backupInvalid(`条目 SHA-256 校验失败：${entryPath}`, 'INTEGRITY_MISMATCH');
    }
    return { size: result.size, sha256: result.sha256 };
  }

  async close(): Promise<void> {
    if (!this.handle) return;
    const h = this.handle;
    this.handle = undefined;
    await h.close();
  }
}
