import { assert, test } from 'orca/testing';

import { PendingReveals } from '../../../src/services/reveals.ts';

const range = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 4 } });

test('a reveal is dropped after 30 s', () => {
  let t = 0;
  const reveals = new PendingReveals(undefined, () => t);
  reveals.add('/w/a.php', range(3));
  t = 29_999;
  assert.deepEqual(reveals.paths(), ['/w/a.php']);
  t = 30_001;
  assert.deepEqual(reveals.paths(), []);
  assert.equal(reveals.take('/w/a.php'), null);
});

test('a reveal is taken once', () => {
  const reveals = new PendingReveals();
  reveals.add('/w/a.php', range(3));
  assert.deepEqual(reveals.take('/w/a.php'), range(3));
  assert.equal(reveals.take('/w/a.php'), null);
});

test('keeps at most five reveals, dropping the oldest, and the newest range for a path', () => {
  const reveals = new PendingReveals();
  for (let i = 0; i < 6; i++) {
    reveals.add(`/w/${i}.php`, range(i));
  }
  reveals.add('/w/3.php', range(30));
  assert.deepEqual(reveals.paths(), ['/w/1.php', '/w/2.php', '/w/4.php', '/w/5.php', '/w/3.php']);
  assert.deepEqual(reveals.take('/w/3.php'), range(30));
  reveals.clear();
  assert.deepEqual(reveals.paths(), []);
});
