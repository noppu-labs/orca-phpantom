import { assert, mockHost, mountWorker, test } from 'orca/testing';

import * as main from '../../src/main.ts';

test('registers every handler and sets the status bar', async () => {
  const worker = await mountWorker(main);
  try {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    assert.deepEqual(
      await worker.request('phpantom.open', {
        docId: 'd1',
        language: 'php',
        workspaceId: null,
        branch: null,
        displayName: null,
        index: 0,
        chunk: '<?php',
        last: false,
      }),
      { state: 'pending' }
    );
    assert.deepEqual(
      await worker.request('phpantom.change', {
        docId: 'd1',
        session: 'old',
        version: 2,
        changes: [],
        length: 5,
      }),
      { detached: true }
    );
    assert.deepEqual(
      await worker.request('phpantom.request', {
        docId: 'd1',
        session: 'old',
        method: 'textDocument/hover',
        params: {},
      }),
      { detached: true }
    );
    assert.deepEqual(
      await worker.request('phpantom.navigate', {
        docId: 'd1',
        session: 'old',
        uri: 'file:///x.php',
        range,
      }),
      { opened: false, reason: 'failed' }
    );
    assert.deepEqual(
      await worker.request('phpantom.peek', {
        docId: 'd1',
        session: 'old',
        uris: ['file:///x.php'],
      }),
      { files: [], omitted: 1 }
    );
    assert.deepEqual(await worker.request('phpantom.ping', { docId: 'd1', session: 'old' }), {
      detached: true,
    });
    assert.deepEqual(await worker.request('phpantom.close', { docId: 'd1' }), { ok: true });
    assert.ok(worker.host.callsOf('statusBar.update').length > 0);
    assert.equal(typeof (await worker.command('phpantom.status')), 'string');
    assert.deepEqual(worker.refusals, []);
  } finally {
    await worker.deactivate();
  }
});

test('settings: a blank path is no path, and downloads are on unless turned off', () => {
  assert.deepEqual(main.readSettings({ phpantomPath: '   ' }), {
    allowDownload: true,
    phpantomPath: '',
  });
  assert.deepEqual(main.readSettings({ phpantomPath: ' /bin/x ', allowDownload: undefined }), {
    allowDownload: true,
    phpantomPath: '/bin/x',
  });
  assert.deepEqual(main.readSettings({ phpantomPath: 7, allowDownload: false }), {
    allowDownload: false,
    phpantomPath: '',
  });
  assert.deepEqual(main.readSettings({ allowDownload: 0 }), {
    allowDownload: true,
    phpantomPath: '',
  });
  assert.deepEqual(main.readSettings({ allowDownload: '' }), {
    allowDownload: true,
    phpantomPath: '',
  });
});

test('the workspace list is cached, and asked again only when the router wants it fresh', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [], truncated: false } } });
  const worker = await mountWorker(main, { host });
  try {
    const open = (docId: string) =>
      worker.request('phpantom.open', {
        docId,
        language: 'php',
        workspaceId: 'not-listed',
        branch: null,
        displayName: null,
        index: 0,
        chunk: '<?php',
        last: true,
      });
    assert.deepEqual(await open('d1'), { state: 'single-file', reason: 'no-file' });
    // The first open fills the cache, then asks fresh for the workspace it lacks.
    assert.equal(host.callsOf('workspace.list').length, 2);
    assert.deepEqual(await open('d2'), { state: 'single-file', reason: 'no-file' });
    // The second takes the cached list, and asks fresh once more.
    assert.equal(host.callsOf('workspace.list').length, 3);
  } finally {
    await worker.deactivate();
  }
});
