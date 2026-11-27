import assert from 'node:assert/strict';
import { test } from 'node:test';

import { capability, isRecord, stringList } from '../../../editor/src/providers/shared.ts';

test('capability walks nested keys and returns undefined off the path', () => {
  assert.equal(capability({ a: { b: true } }, 'a', 'b'), true);
  assert.equal(capability({ a: 1 }, 'a', 'b'), undefined);
  assert.equal(capability({}, 'a'), undefined);
});

test('isRecord rejects null and arrays', () => {
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord({}), true);
});

test('capability does not walk into lists or other values', () => {
  assert.equal(capability({ a: true }, 'a', 'b'), undefined);
  assert.equal(capability({ a: [1, 2] }, 'a', 'length'), undefined);
  assert.equal(capability({ a: 'text' }, 'a', 'length'), undefined);
  assert.equal(capability({ a: null }, 'a', 'b'), undefined);
  assert.equal(capability({ a: { b: false } }, 'a', 'b'), false);
});

test('isRecord accepts an Error, as reading its code did', () => {
  assert.equal(isRecord(new Error('x')), true);
  assert.equal(isRecord('text'), false);
  assert.equal(isRecord(undefined), false);
});

test('stringList keeps a list, empty or not, and drops anything else', () => {
  const list = ['.', '->'];
  assert.equal(stringList(list), list);
  assert.deepEqual(stringList([]), []);
  for (const odd of [undefined, null, true, '.', {}]) {
    assert.equal(stringList(odd), undefined);
  }
});
