// Adapted from actus7/orca-autocomplete editor/src/edits.test.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
import { assert, test } from 'orca/testing';

import { smallestEdit } from '../../editor/src/edits.ts';

const apply = (before: string, edit: { start: number; end: number; text: string }): string =>
  before.slice(0, edit.start) + edit.text + before.slice(edit.end);

test('smallestEdit returns null for equal text', () => {
  assert.equal(smallestEdit('same', 'same'), null);
});

test('smallestEdit finds the changed middle and applying it gives the new text', () => {
  const cases: [string, string][] = [
    ['const a = 1', 'const a = 2'],
    ['hello world', 'hello brave new world'],
    ['line1\nline2\nline3', 'line1\nline3'],
    ['', 'abc'],
    ['abc', ''],
    ['aaa', 'aa'],
    ['a\nb', 'a\r\nb'],
  ];
  for (const [before, after] of cases) {
    const edit = smallestEdit(before, after);
    assert.ok(edit, `${before} -> ${after}`);
    assert.equal(apply(before, edit), after);
  }
});

test('smallestEdit touches only what changed', () => {
  assert.deepEqual(smallestEdit('const a = 1;', 'const a = 22;'), {
    start: 10,
    end: 11,
    text: '22',
  });
});

test('smallestEdit never cuts an emoji in half', () => {
  const before = 'x \u{1F600} y';
  const after = 'x \u{1F601} y';
  const edit = smallestEdit(before, after);
  assert.ok(edit);
  assert.equal(apply(before, edit), after);
  assert.equal(edit.text, '\u{1F601}');
});
