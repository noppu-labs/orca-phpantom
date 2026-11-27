import { assert, test } from 'orca/testing';

import {
  chunkText,
  encodedSize,
  REQUEST_BUDGET_BYTES,
  REQUEST_BUDGET_OBJECTS,
  splitChanges,
} from '../../editor/src/split.ts';
import { DocumentMirror } from '../../src/services/lsp/mirror.ts';
import { orcaSize } from '../../src/utils/size.ts';

const ins = (line: number, character: number, text: string) => ({
  range: { start: { line, character }, end: { line, character } },
  text,
});

test('small changes stay in one group', () => {
  assert.equal(splitChanges([ins(0, 0, 'a'), ins(0, 1, 'b')]).length, 1);
});

test('split changes rebuild the same text', () => {
  const base = 'x\n'.repeat(1000);
  const big = 'é😀\r\n"quote" \\ tab\t'.repeat(9000);
  const change = {
    range: { start: { line: 3, character: 0 }, end: { line: 5, character: 1 } },
    text: big,
  };
  const expected = new DocumentMirror(base);
  expected.apply([change]);
  const actual = new DocumentMirror(base);
  const groups = splitChanges([change]);
  assert.ok(groups.length > 1);
  for (const group of groups) {
    assert.ok(encodedSize(group) <= REQUEST_BUDGET_BYTES);
    actual.apply(group);
  }
  assert.equal(actual.text, expected.text);
});

test('split full-text and lone-CR changes rebuild the same text', () => {
  for (const big of [`${'line\r'.repeat(30_000)}é`, 'a\r\n'.repeat(30_000)]) {
    for (const change of [
      { text: big },
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, text: big },
    ]) {
      const base = 'q\n\nr\n';
      const expected = new DocumentMirror(base);
      expected.apply([change]);
      const actual = new DocumentMirror(base);
      for (const group of splitChanges([change], 2048)) {
        assert.ok(encodedSize(group) <= 2048);
        actual.apply(group);
      }
      assert.equal(actual.text, expected.text);
    }
  }
});

test("many one-character edits split into groups under Orca's request limit", () => {
  const changes = Array.from({ length: 3000 }, (_, i) => ins(i, 0, 'x'));
  const groups = splitChanges(changes);
  assert.ok(groups.length > 1);
  for (const group of groups) {
    const size = orcaSize(group);
    // 64 KiB and 10,000 objects are Orca's limits for the whole message; the group is held well inside them.
    assert.ok(size.bytes <= REQUEST_BUDGET_BYTES, `bytes ${size.bytes}`);
    assert.ok(size.objects <= REQUEST_BUDGET_OBJECTS, `objects ${size.objects}`);
  }
  assert.deepEqual(groups.flat(), changes);
});

test("a large paste splits into pieces under Orca's request limit", () => {
  const groups = splitChanges([ins(0, 0, 'é"\n€😀 '.repeat(20_000))]);
  assert.ok(groups.length > 1);
  for (const group of groups) {
    assert.ok(orcaSize(group).bytes <= REQUEST_BUDGET_BYTES);
    assert.ok(encodedSize(group) <= REQUEST_BUDGET_BYTES);
  }
});

test('groups keep order and respect the budget', () => {
  const changes = Array.from({ length: 50 }, (_, i) => ins(i, 0, 'abcdefghij'.repeat(10)));
  const groups = splitChanges(changes, 1024);
  assert.ok(groups.length > 1);
  for (const g of groups) assert.ok(encodedSize(g) <= 1024);
  assert.deepEqual(groups.flat(), changes);
});

test('never splits a surrogate pair', () => {
  for (const piece of chunkText('😀'.repeat(40_000), 1024)) {
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(piece));
  }
});

test('chunkText pieces fit the budget and join back', () => {
  const text = 'a"\\\n\u0001é€😀'.repeat(3000);
  const pieces = chunkText(text, 500);
  for (const p of pieces) assert.ok(encodedSize(p) <= 500);
  assert.equal(pieces.join(''), text);
  assert.deepEqual(chunkText(''), ['']);
});

test('an insertion after a lone CR whose text starts with LF rebuilds exactly', () => {
  const change = ins(1, 0, `\n${'x\n'.repeat(3000)}`);
  const expected = new DocumentMirror('a\rb\rc');
  expected.apply([change]);
  const actual = new DocumentMirror('a\rb\rc');
  const groups = splitChanges([change], 2048);
  assert.ok(groups.length > 1);
  for (const group of groups) actual.apply(group);
  assert.equal(actual.text, expected.text);
});

const loneSurrogate = /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/;

test('a cut back from an LF never lands inside a surrogate pair', () => {
  for (const [text, budget] of [
    ['😀😀\n', 11],
    ['ab😀\nx', 9],
  ] as const) {
    const pieces = chunkText(text, budget);
    assert.equal(pieces.join(''), text);
    for (const p of pieces) {
      assert.ok(!loneSurrogate.test(p));
      assert.ok(encodedSize(p) <= budget);
    }
  }
});

test('random mixed texts split within budget, without lone surrogates, and rejoin', () => {
  let seed = 12_345;
  const rnd = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff), seed % n);
  const atoms = ['\r\n', '\n', '\r', '😀', 'é', '"', '\\', 'a', '€', '\t'];
  for (let n = 0; n < 300; n++) {
    let text = '';
    for (let k = rnd(200); k > 0; k--) text += atoms[rnd(atoms.length)];
    const budget = 8 + rnd(60);
    const pieces = chunkText(text, budget);
    assert.equal(pieces.join(''), text);
    for (const p of pieces) {
      assert.ok(!loneSurrogate.test(p));
      assert.ok(encodedSize(p) <= budget);
    }
    const groups = splitChanges([ins(0, 0, text)], 300 + rnd(200));
    const actual = new DocumentMirror('');
    for (const g of groups) actual.apply(g);
    assert.equal(actual.text, text);
  }
});
