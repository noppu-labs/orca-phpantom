import { inflateRawSync, gunzipSync } from 'node:zlib';

/** The one file `member` from a tar.gz or zip, using Node builtins only. */
export function extractSingleFile(archive: Buffer, kind: 'tar.gz' | 'zip', member: string): Buffer {
  const found = kind === 'tar.gz' ? fromTar(gunzipSync(archive), member) : fromZip(archive, member);
  if (!found) {
    throw new Error(`archive has no ${member}`);
  }
  return found;
}

function fromTar(tar: Buffer, member: string): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      return null;
    }
    const name = cString(header.subarray(0, 100));
    const size = Number.parseInt(cString(header.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const start = offset + 512;
    const base = name.replace(/^\.\//, '');
    if (type === '0' && base === member) {
      return Buffer.from(tar.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

function fromZip(zip: Buffer, member: string): Buffer | null {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xff_ff); i--) {
    if (zip.readUInt32LE(i) === 0x06_05_4b_50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error('not a zip archive');
  }
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(at) !== 0x02_01_4b_50) {
      throw new Error('corrupt zip directory');
    }
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (name === member) {
      if (zip.readUInt32LE(localOffset) !== 0x04_03_4b_50) {
        throw new Error('corrupt zip entry');
      }
      const dataStart =
        localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) {
        return Buffer.from(data);
      }
      if (method === 8) {
        return inflateRawSync(data);
      }
      throw new Error(`unsupported zip method ${method}`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}
