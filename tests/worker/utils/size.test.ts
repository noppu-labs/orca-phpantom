import { assert, test } from 'orca/testing';

import { leadingThatFit, orcaSize } from '../../../src/utils/size.ts';

const location = {
  uri: 'file:///a',
  range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } },
};

test('measures a value the way Orca does, not as JSON', () => {
  // Uri 4+3+9, range 4+5, start 4+5 and end 4+3, each position (4+4+8)+(4+9+8); four objects.
  assert.deepEqual(orcaSize(location), { bytes: 115, objects: 4 });
  // An array adds 8, and 4 per element.
  assert.deepEqual(orcaSize([location]), { bytes: 127, objects: 5 });
  assert.deepEqual(orcaSize({ a: null, b: true, c: 'é' }), {
    bytes: 5 + 1 + 5 + 1 + 5 + 2,
    objects: 1,
  });
});

test('keeps the leading items that fit beside the envelope, by bytes and by objects', () => {
  const items = Array.from({ length: 10 }, () => location);
  assert.equal(
    leadingThatFit(items, { bytes: 0, objects: 1 }, { bytes: 10_000, objects: 13 }).length,
    3
  );
  assert.equal(
    leadingThatFit(items, { bytes: 100, objects: 0 }, { bytes: 100 + 2 * 119, objects: 1000 })
      .length,
    2
  );
});
