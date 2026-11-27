import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

// Builds the tar.gz and zip archives the binary tests read, in memory, so no archive is committed.
// Orca's plugin indexer refuses any archive in a tagged commit.

export type ArchiveFiles = Record<string, string | Buffer>;

const MTIME = 1_700_000_000;

const bytes = (data: string | Buffer): Buffer =>
  typeof data === 'string' ? Buffer.from(data) : data;

/** The ustar header checksum: the sum of all 512 bytes with the checksum field read as spaces. */
export function tarChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  }
  return sum;
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write(`${MTIME.toString(8).padStart(11, '0')}\0`, 136, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.write(`${tarChecksum(header).toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return header;
}

/** An uncompressed ustar archive: one regular-file entry per file, then two zero blocks. */
export function tar(files: ArchiveFiles): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of Object.entries(files)) {
    const body = bytes(data);
    parts.push(tarHeader(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A gzip-compressed ustar archive. */
export function tarGz(files: ArchiveFiles): Buffer {
  return gzipSync(tar(files));
}

export type ZipOptions = {
  /** Store entries uncompressed (method 0) or deflate them (method 8). Defaults to stored. */
  method?: 'stored' | 'deflate';
};

/** A zip with a local header and a central-directory record per file, then the end record. */
export function zip(files: ArchiveFiles, options: ZipOptions = {}): Buffer {
  const method = options.method === 'deflate' ? 8 : 0;
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const raw = bytes(data);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(method === 8 ? 20 : 10, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4);
    entry.writeUInt16LE(method === 8 ? 20 : 10, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const count = Object.keys(files).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** What the old committed one.tar.gz held: a single `phpantom_lsp` file. */
export const oneTarGz = (): Buffer => tarGz({ phpantom_lsp: 'fake-binary' });

/** What the old committed one.zip held: a single stored `phpantom_lsp.exe`. */
export const oneZip = (): Buffer => zip({ 'phpantom_lsp.exe': 'fake-exe' });
