import { assert, mountWorker, test } from 'orca/testing'
import * as main from './main.ts'

test('registers every handler and sets the status bar', async () => {
  const worker = await mountWorker(main)
  try {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
    assert.deepEqual(
      await worker.request('phpantom.open', { docId: 'd1', language: 'php', workspaceId: null, branch: null, displayName: null, index: 0, chunk: '<?php', last: false }),
      { state: 'pending' }
    )
    assert.deepEqual(await worker.request('phpantom.change', { docId: 'd1', session: 'old', version: 2, changes: [], length: 5 }), { detached: true })
    assert.deepEqual(await worker.request('phpantom.request', { docId: 'd1', session: 'old', method: 'textDocument/hover', params: {} }), { detached: true })
    assert.deepEqual(await worker.request('phpantom.navigate', { docId: 'd1', session: 'old', uri: 'file:///x.php', range }), { opened: false, reason: 'failed' })
    assert.deepEqual(await worker.request('phpantom.peek', { docId: 'd1', session: 'old', uris: ['file:///x.php'] }), { files: [], omitted: 1 })
    assert.deepEqual(await worker.request('phpantom.ping', { docId: 'd1', session: 'old' }), { detached: true })
    assert.deepEqual(await worker.request('phpantom.close', { docId: 'd1' }), { ok: true })
    assert.ok(worker.host.callsOf('statusBar.update').length >= 1)
    assert.equal(typeof (await worker.command('phpantom.status')), 'string')
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})
