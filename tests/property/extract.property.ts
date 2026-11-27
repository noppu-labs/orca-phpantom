import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { extractSingleFile } from '../../src/services/binary/extract.ts';
import { oneTarGz, oneZip, tar, tarGz, zip } from '../helpers/archives.ts';
import { fc } from './setup.ts';

type Kind = 'tar.gz' | 'zip';

/** Runs the extraction and reports how it ended, failing the property on a throw that is not an Error. */
function attempt(archive: Buffer, kind: Kind, member: string): Buffer | Error {
  try {
    return extractSingleFile(archive, kind, member);
  } catch (error) {
    assert.ok(error instanceof Error, `threw a non-Error: ${String(error)}`);
    return error;
  }
}

const member = fc.constantFrom('phpantom_lsp', 'phpantom_lsp.exe', 'other');

const memberBytes = fc.uint8Array({ minLength: 1 }).map((array) => Buffer.from(array));
const zipMethod = fc.constantFrom<'stored' | 'deflate'>('stored', 'deflate');

/** A copy of `archive` with some bytes overwritten, so the parsers read headers that are almost right. */
const corrupted = (archive: Buffer, edits: { at: number; byte: number }[]): Buffer => {
  const copy = Buffer.from(archive);
  for (const { at, byte } of edits) copy[at % copy.length] = byte;
  return copy;
};
const edits = fc.array(fc.record({ at: fc.nat(), byte: fc.integer({ min: 0, max: 0xff }) }), {
  minLength: 1,
});

// The size field is 12 bytes of octal text at offset 124: negative, not octal at all, or far past the archive.
// Sizes within two blocks matter most: from -512 to -1023 the walk's next offset would be the one it is on.
const size = fc.oneof(fc.nat({ max: 2 * 512 }), fc.nat());
const sizeField = fc.oneof(
  size.map((bytes) => `-${bytes.toString(8)}`),
  size.map((bytes) => bytes.toString(8)),
  fc.string({ maxLength: 12 })
);

/** A tar whose first entry, before the member, has its size field replaced by `field`. */
function withSizeField(data: Buffer, field: string): Buffer {
  const raw = tar({ other: data, phpantom_lsp: 'x' });
  raw.fill(0, 124, 136);
  raw.write(field, 124, 12, 'ascii');
  return raw;
}

// Arbitrary bytes are too short and never valid gzip, so they stop before either parser's loop.
// Corrupted copies of real archives are what reach the tar header walk and the zip directory scan.
const bytes = fc.uint8Array().map((array) => Buffer.from(array));
const archiveLike = fc.oneof(
  fc.tuple(bytes, fc.constantFrom<Kind>('tar.gz', 'zip')),
  fc.tuple(
    bytes.map((raw) => gzipSync(raw)),
    fc.constant<Kind>('tar.gz')
  ),
  fc.tuple(
    fc
      .tuple(memberBytes, edits)
      .map(([data, changes]) => gzipSync(corrupted(tar({ phpantom_lsp: data }), changes))),
    fc.constant<Kind>('tar.gz')
  ),
  {
    arbitrary: fc.tuple(
      fc.tuple(memberBytes, sizeField).map(([data, field]) => gzipSync(withSizeField(data, field))),
      fc.constant<Kind>('tar.gz')
    ),
    weight: 2,
  },
  fc.tuple(
    fc
      .tuple(memberBytes, zipMethod, edits)
      .map(([data, method, changes]) =>
        corrupted(zip({ 'phpantom_lsp.exe': data }, { method }), changes)
      ),
    fc.constant<Kind>('zip')
  )
);

test('extractSingleFile throws an Error or returns a Buffer for arbitrary bytes', () => {
  fc.assert(
    fc.property(archiveLike, member, ([archive, which], name) => {
      const result = attempt(archive, which, name);
      assert.ok(result instanceof Error || Buffer.isBuffer(result));
    })
  );
});

interface ValidArchive {
  archive: Buffer;
  kind: Kind;
  member: string;
  content: Buffer;
}

const tarHolding = (content: Buffer, archive = tarGz({ phpantom_lsp: content })): ValidArchive => ({
  archive,
  kind: 'tar.gz',
  member: 'phpantom_lsp',
  content,
});

const zipHolding = (content: Buffer, archive: Buffer): ValidArchive => ({
  archive,
  kind: 'zip',
  member: 'phpantom_lsp.exe',
  content,
});

/** A valid archive with one member, of either kind and either zip method. */
const archive = fc.oneof(
  fc.constant(tarHolding(Buffer.from('fake-binary'), oneTarGz())),
  fc.constant(zipHolding(Buffer.from('fake-exe'), oneZip())),
  memberBytes.map((data) => tarHolding(data)),
  fc
    .tuple(memberBytes, zipMethod)
    .map(([data, method]) => zipHolding(data, zip({ 'phpantom_lsp.exe': data }, { method })))
);

test('a truncated copy of a valid archive never returns different bytes', () => {
  fc.assert(
    fc.property(archive, fc.nat(), (valid, at) => {
      assert.deepEqual(extractSingleFile(valid.archive, valid.kind, valid.member), valid.content);
      const prefix = valid.archive.subarray(0, at % valid.archive.length);
      const result = attempt(prefix, valid.kind, valid.member);
      if (!(result instanceof Error)) assert.deepEqual(result, valid.content);
    })
  );
});
