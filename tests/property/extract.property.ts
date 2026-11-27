import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { extractSingleFile } from '../../src/services/binary/extract.ts';
import { oneTarGz, oneZip, tarGz, zip } from '../helpers/archives.ts';
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

const kind = fc.constantFrom<Kind>('tar.gz', 'zip');
const member = fc.constantFrom('phpantom_lsp', 'phpantom_lsp.exe', 'other');

// Arbitrary bytes are almost never valid gzip, so the gzipped copy is what reaches the tar reader.
const bytes = fc.uint8Array().map((array) => Buffer.from(array));
const archiveLike = fc.oneof(
  bytes,
  bytes.map((raw) => gzipSync(raw))
);

test('extractSingleFile throws an Error or returns a Buffer for arbitrary bytes', () => {
  fc.assert(
    fc.property(archiveLike, kind, member, (archive, which, name) => {
      const result = attempt(archive, which, name);
      assert.ok(result instanceof Error || Buffer.isBuffer(result));
    })
  );
});

const memberBytes = fc.uint8Array({ minLength: 1 }).map((array) => Buffer.from(array));

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
    .tuple(memberBytes, fc.constantFrom<'stored' | 'deflate'>('stored', 'deflate'))
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
