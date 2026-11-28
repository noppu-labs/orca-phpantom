import { assert, test } from 'orca/testing';

import { aggregate, renderStatus } from './status.ts';

test('no servers renders idle', () => {
  assert.deepEqual(renderStatus(aggregate([])), {
    id: 'phpantom',
    text: 'PHPantom',
    icon: 'code',
    tone: 'neutral',
    tooltip: 'PHPantom: no PHP files open',
  });
});
test('an error outranks indexing', () => {
  const s = aggregate([
    { phase: 'indexing', percent: 40 },
    { phase: 'error', message: 'exited (code 1)' },
  ]);
  assert.equal(s.phase, 'error');
  assert.deepEqual(renderStatus(s), {
    id: 'phpantom',
    text: 'PHPantom: error',
    icon: 'error',
    tone: 'danger',
    tooltip: 'PHPantom: exited (code 1)',
  });
});
test('indexing shows the lowest percent', () => {
  assert.equal(
    renderStatus(
      aggregate([
        { phase: 'indexing', percent: 70 },
        { phase: 'indexing', percent: 20 },
      ])
    ).text,
    'PHPantom: indexing 20%'
  );
});
test('ready names the version and where it came from', () => {
  assert.deepEqual(renderStatus({ phase: 'ready', version: '1.1.0', source: 'download' }), {
    id: 'phpantom',
    text: 'PHPantom',
    icon: 'check',
    tone: 'neutral',
    tooltip: 'PHPantom 1.1.0 (downloaded), ready',
  });
});
