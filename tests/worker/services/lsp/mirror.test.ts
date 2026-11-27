import { assert, test } from 'orca/testing';

import { DocumentMirror } from '../../../../src/services/lsp/mirror.ts';

const ins = (line: number, character: number, text: string) => ({
  range: { start: { line, character }, end: { line, character } },
  text,
});

test('mirror applies changes in the order Monaco sends them', () => {
  const m = new DocumentMirror('abc\ndef\n');
  m.apply([ins(1, 3, '!'), ins(0, 0, '>')]);
  assert.equal(m.text, '>abc\ndef!\n');
});

test('a full-text change replaces everything', () => {
  const m = new DocumentMirror('a');
  m.apply([{ text: 'b' }]);
  assert.equal(m.text, 'b');
  assert.equal(m.length, 1);
});

test('handles CRLF and lone CR line ends', () => {
  const m = new DocumentMirror('a\r\nb');
  m.apply([ins(1, 1, 'c')]);
  assert.equal(m.text, 'a\r\nbc');
  const cr = new DocumentMirror('a\rb\rc');
  cr.apply([ins(2, 1, '!'), ins(1, 0, '>')]);
  assert.equal(cr.text, 'a\r>b\rc!');
});

test('positions past the end clamp, and ranges replace', () => {
  const m = new DocumentMirror('ab\r\ncd');
  m.apply([ins(0, 99, 'X')]);
  assert.equal(m.text, 'abX\r\ncd');
  m.apply([ins(9, 0, 'Z')]);
  assert.equal(m.text, 'abX\r\ncdZ');
  m.apply([
    { range: { start: { line: 0, character: 1 }, end: { line: 1, character: 1 } }, text: '-' },
  ]);
  assert.equal(m.text, 'a-dZ');
});

test('a surrogate pair beside a line end counts as two code units and never as a line end', () => {
  const m = new DocumentMirror('a😀\r\n😀b\r😀');
  m.apply([ins(1, 2, '!'), ins(2, 9, '?'), ins(0, 3, '>')]);
  assert.equal(m.text, 'a😀>\r\n😀!b\r😀?');
});
