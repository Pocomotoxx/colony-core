import { inflateRawSync } from 'node:zlib';

/**
 * A small, strict reader for zip archives (the release packages of the vendored rule sets). It reads the central
 * directory, supports stored and deflated entries, checks every entry's CRC-32 and size, and refuses what it does not
 * handle (encryption, zip64, other compression methods, names that leave the archive). Nothing is written to disk here:
 * the caller gets the bytes. Limits keep a hostile archive (a zip bomb) from using the memory of the process.
 */

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  size: number;
  data(): Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

const DEFAULT_LIMITS: ZipLimits = { maxEntries: 5000, maxEntryBytes: 5_000_000, maxTotalBytes: 100_000_000 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function safeName(name: string): boolean {
  return name.length > 0 && name.length < 400 && !name.includes('\0') && !name.includes('\\') && !name.startsWith('/') && !/^[A-Za-z]:/.test(name) && !name.split('/').some((s) => s === '..');
}

/** The entries of a zip archive (directories are left out). Reading an entry's data checks its size and CRC-32. */
export function readZip(buf: Buffer, limits: Partial<ZipLimits> = {}): ZipEntry[] {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  // the end of central directory record: the last 22 bytes, or up to 64 KB of comment after it
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('this is not a zip archive (no end of central directory record)');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
  if (total > lim.maxEntries) throw new ZipError(`the archive has more than ${lim.maxEntries} entries`);
  if (cdOffset + cdSize > buf.length) throw new ZipError('the central directory lies outside the file');

  const entries: ZipEntry[] = [];
  let pos = cdOffset;
  let declared = 0;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new ZipError('the central directory is damaged');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf-8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // a directory
    if (!safeName(name)) throw new ZipError(`the entry name ${JSON.stringify(name.slice(0, 80))} is not allowed`);
    if (flags & 1) throw new ZipError(`${name}: encrypted entries are not supported`);
    if (method !== 0 && method !== 8) throw new ZipError(`${name}: compression method ${method} is not supported`);
    if (size > lim.maxEntryBytes) throw new ZipError(`${name}: larger than ${lim.maxEntryBytes} bytes`);
    declared += size;
    if (declared > lim.maxTotalBytes) throw new ZipError(`the archive holds more than ${lim.maxTotalBytes} bytes`);

    entries.push({
      name,
      size,
      data(): Buffer {
        if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError(`${name}: the local header is damaged`);
        const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
        if (start + compSize > buf.length) throw new ZipError(`${name}: the data lies outside the file`);
        const raw = buf.subarray(start, start + compSize);
        let out: Buffer;
        try {
          out = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: lim.maxEntryBytes });
        } catch (err) {
          throw new ZipError(`${name}: cannot be decompressed (${err instanceof Error ? err.message : String(err)})`);
        }
        if (out.length !== size) throw new ZipError(`${name}: the size is not the declared one`);
        if (crc32(out) !== crc) throw new ZipError(`${name}: the CRC-32 does not match (the archive is damaged)`);
        return out;
      },
    });
  }
  return entries;
}
