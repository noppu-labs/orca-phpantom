import { inflateRawSync, gunzipSync } from 'node:zlib';

// A tar is 512-byte blocks; a header block holds the name, the size in octal and the type ('0', or NUL, for a file).
const TAR_BLOCK = 512;
const TAR_NAME_END = 100;
const TAR_SIZE_START = 124;
const TAR_SIZE_END = 136;
const TAR_TYPE_AT = 156;
const TAR_FILE_TYPE = 0x30;

// A zip ends with its end-of-central-directory record, which a comment of up to 64 KiB may follow.
const ZIP_END_SIGNATURE = 0x06_05_4b_50;
const ZIP_END_SIZE = 22;
const ZIP_MAX_COMMENT = 0xff_ff;
const ZIP_END_ENTRIES_AT = 10;
const ZIP_END_DIRECTORY_AT = 16;
// The central directory has one header per entry.
const ZIP_ENTRY_SIGNATURE = 0x02_01_4b_50;
const ZIP_ENTRY_METHOD_AT = 10;
const ZIP_ENTRY_COMPRESSED_SIZE_AT = 20;
const ZIP_ENTRY_NAME_LENGTH_AT = 28;
const ZIP_ENTRY_EXTRA_LENGTH_AT = 30;
const ZIP_ENTRY_COMMENT_LENGTH_AT = 32;
const ZIP_ENTRY_LOCAL_AT = 42;
const ZIP_ENTRY_NAME_AT = 46;
// Each entry's data follows its local header, whose name and extra field may differ from the directory's.
const ZIP_LOCAL_SIGNATURE = 0x04_03_4b_50;
const ZIP_LOCAL_NAME_LENGTH_AT = 26;
const ZIP_LOCAL_EXTRA_LENGTH_AT = 28;
const ZIP_LOCAL_NAME_AT = 30;
const ZIP_DEFLATE = 8;

/** The one file `member` from a tar.gz or zip, using Node builtins only. */
function extractSingleFile(archive: Buffer, kind: 'tar.gz' | 'zip', member: string): Buffer {
  const found = kind === 'tar.gz' ? fromTar(gunzipSync(archive), member) : fromZip(archive, member);
  if (!found) {
    throw new Error(`archive has no ${member}`);
  }
  return found;
}

function fromTar(tar: Buffer, member: string): Buffer | null {
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) {
      return null;
    }
    const name = cString(header.subarray(0, TAR_NAME_END));
    const size = Number.parseInt(
      cString(header.subarray(TAR_SIZE_START, TAR_SIZE_END)).trim() || '0',
      8
    );
    const type = String.fromCodePoint(header[TAR_TYPE_AT] || TAR_FILE_TYPE);
    const start = offset + TAR_BLOCK;
    // Why: a negative or unreadable size would stop the walk from advancing, and a size past the end reads a short file.
    if (!(size >= 0) || start + size > tar.length) throw new Error('corrupt tar header');
    const base = name.replace(/^\.\//u, '');
    if (type === '0' && base === member) {
      return Buffer.from(tar.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return null;
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

function fromZip(zip: Buffer, member: string): Buffer | null {
  let eocd = -1;
  for (
    let candidate = zip.length - ZIP_END_SIZE;
    candidate >= Math.max(0, zip.length - ZIP_END_SIZE - ZIP_MAX_COMMENT);
    candidate--
  ) {
    if (zip.readUInt32LE(candidate) === ZIP_END_SIGNATURE) {
      eocd = candidate;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error('not a zip archive');
  }
  const entries = zip.readUInt16LE(eocd + ZIP_END_ENTRIES_AT);
  let at = zip.readUInt32LE(eocd + ZIP_END_DIRECTORY_AT);
  for (let index = 0; index < entries; index++) {
    if (zip.readUInt32LE(at) !== ZIP_ENTRY_SIGNATURE) {
      throw new Error('corrupt zip directory');
    }
    const method = zip.readUInt16LE(at + ZIP_ENTRY_METHOD_AT);
    const compressedSize = zip.readUInt32LE(at + ZIP_ENTRY_COMPRESSED_SIZE_AT);
    const nameLength = zip.readUInt16LE(at + ZIP_ENTRY_NAME_LENGTH_AT);
    const extraLength = zip.readUInt16LE(at + ZIP_ENTRY_EXTRA_LENGTH_AT);
    const commentLength = zip.readUInt16LE(at + ZIP_ENTRY_COMMENT_LENGTH_AT);
    const localOffset = zip.readUInt32LE(at + ZIP_ENTRY_LOCAL_AT);
    const name = zip
      .subarray(at + ZIP_ENTRY_NAME_AT, at + ZIP_ENTRY_NAME_AT + nameLength)
      .toString('utf8');
    if (name === member) {
      if (zip.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
        throw new Error('corrupt zip entry');
      }
      const dataStart =
        localOffset +
        ZIP_LOCAL_NAME_AT +
        zip.readUInt16LE(localOffset + ZIP_LOCAL_NAME_LENGTH_AT) +
        zip.readUInt16LE(localOffset + ZIP_LOCAL_EXTRA_LENGTH_AT);
      // Why: an entry's data ends before the central directory, so data reaching this record is a cut or corrupt archive.
      if (dataStart + compressedSize > at) throw new Error('corrupt zip entry');
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) {
        return Buffer.from(data);
      }
      if (method === ZIP_DEFLATE) {
        return inflateRawSync(data);
      }
      throw new Error(`unsupported zip method ${method}`);
    }
    at += ZIP_ENTRY_NAME_AT + nameLength + extraLength + commentLength;
  }
  return null;
}

export { extractSingleFile };
