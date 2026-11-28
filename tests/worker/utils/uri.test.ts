// Adapted from actus7/orca-autocomplete src/lsp/uri.test.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
import { assert, test } from 'orca/testing';

import { isFileUri, sameUri, uriKey } from '../../../src/utils/uri.ts';

test('the spellings a server may use for one Windows file are the same file', () => {
  assert.ok(sameUri('file:///E:/projetos/a.ts', 'file:///e%3A/projetos/a.ts'));
  assert.ok(sameUri('file:///E:/projetos/a.ts', 'file:///E%3a/Projetos/A.ts'));
  assert.ok(sameUri('file:///C:/Users/me/a%20b.ts', 'file:///c%3A/users/me/a b.ts'));
});

test('different files, and Unix paths that differ only in case, stay different', () => {
  assert.equal(sameUri('file:///E:/a.ts', 'file:///E:/b.ts'), false);
  assert.equal(sameUri('file:///home/me/A.ts', 'file:///home/me/a.ts'), false);
  assert.ok(sameUri('file:///home/me/a.ts', 'file:///home/me/a.ts'));
});

test('uriKey tolerates a malformed escape and a Windows separator', () => {
  assert.equal(uriKey('file:///home/me/%E0%A4%A'), '/home/me/%E0%A4%A');
  assert.equal(uriKey(String.raw`file:///C:\a\b`), '/c:/a/b');
});

test('a file URI is told apart by its scheme in any case', () => {
  assert.ok(isFileUri('file:///home/me/a.php'));
  assert.ok(isFileUri('FILE:///C:/a.php'));
  assert.equal(isFileUri('https://example.com/a.php'), false);
  assert.equal(isFileUri('untitled:a.php'), false);
});

test('only a drive letter makes a path ignore case', () => {
  assert.equal(uriKey('file:///D:/App/A.php'), '/d:/app/a.php');
  assert.equal(uriKey('file:///1:/App/A.php'), '/1:/App/A.php');
});
