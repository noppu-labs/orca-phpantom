import { assert, test } from 'orca/testing';

import { isRecord, isTruthy } from '../../../src/utils/json.ts';

test('isTruthy reads a value as an if does', () => {
  for (const value of [undefined, null, false, 0, -0, 0n, '', Number.NaN]) {
    assert.equal(Boolean(value), false);
    assert.equal(isTruthy(value), false, String(value));
  }
  for (const value of [true, 1, -1, 1n, 'x', ' ', '0', 'false', {}, [], Number.POSITIVE_INFINITY]) {
    assert.equal(Boolean(value), true);
    assert.equal(isTruthy(value), true, String(value));
  }
});

test('isRecord takes objects only', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
});
