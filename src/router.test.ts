import { afterEach, assert, test } from 'orca/testing'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { LspRange } from './protocol.ts'
import { PhpantomServer, type ServerEvents } from './lsp/server.ts'
import type { WorkspaceRow } from './locate/workspaces.ts'
import { Router, type RouterHost } from './router.ts'
import type { StatusBarUpdate } from './status.ts'

const FAKE = fileURLToPath(new URL('./lsp/fixtures/fake-server.mjs', import.meta.url))

class RecordingServer extends PhpantomServer {
  readonly notified: { method: string; params: any }[] = []

  override notify(method: string, params: unknown): void {
    this.notified.push({ method, params })
    super.notify(method, params)
  }
}

type Post = { event: string; payload: any; panel: string }
type Started = { root: string; server: RecordingServer; events: ServerEvents }

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

const spawnFake = ((_executable: string, _args: string[], options: object) => spawn(process.execPath, [FAKE], options as never)) as unknown as typeof spawn

async function setup(options: { files?: Record<string, string>; rows?: (dir: string) => WorkspaceRow[]; idleMs?: number } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'phpantom-router-')))
  mkdirSync(join(dir, 'a'))
  mkdirSync(join(dir, 'b'))
  const docs: Record<string, string> = {}
  for (const [relative, text] of Object.entries(options.files ?? {})) {
    const path = join(dir, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    docs[relative] = path
  }
  const rows = options.rows?.(dir) ?? [
    { id: 'ws-a', name: 'a', branch: 'main', path: join(dir, 'a'), hostId: 'local' },
    { id: 'ws-b', name: 'b', branch: 'feat', path: join(dir, 'b'), hostId: 'local' }
  ]
  const posts: Post[] = []
  const statuses: StatusBarUpdate[] = []
  const opened: { workspaceId: string; path: string }[] = []
  const logs: string[] = []
  const host: RouterHost = {
    listWorkspaces: async () => rows,
    openEditor: async (workspaceId, path) => void opened.push({ workspaceId, path }),
    post: (event, payload, postOptions) => void posts.push({ event, payload, panel: postOptions.panel }),
    status: (update) => void statuses.push(update),
    log: (message) => void logs.push(message),
    settings: async () => ({ phpantomPath: '', allowDownload: false })
  }
  const started: Started[] = []
  const router = new Router(host, {
    resolve: async () => ({ ok: true, path: 'phpantom_lsp', version: '1.1.0', source: 'path' }),
    createServer: (executable, root, events) => {
      const server = new RecordingServer({ executable, root, events, spawnImpl: spawnFake, initializeTimeoutMs: 5000 })
      started.push({ root, server, events })
      return server
    },
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs })
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => router.dispose())

  const worker = {
    request(name: string, input: any, panel = 'panel-1'): Promise<any> {
      switch (name) {
        case 'phpantom.open':
          return router.open(input, { panel })
        case 'phpantom.change':
          return router.change(input)
        case 'phpantom.request':
          return router.request(input, new AbortController().signal)
        case 'phpantom.close':
          return router.close(input)
        case 'phpantom.navigate':
          return router.navigate(input)
        case 'phpantom.peek':
          return router.peek(input)
        default:
          throw new Error(`unknown request ${name}`)
      }
    }
  }
  return { worker, router, docs, dir, rows, posts, statuses, opened, logs, started }
}

type Worker = Awaited<ReturnType<typeof setup>>['worker']

/** Sends the text in small chunks, checking each one before the last answers pending. */
async function openWhole(
  worker: Worker,
  input: { docId: string; language: 'php' | 'blade'; workspaceId: string | null; text: string; resync?: true; panel?: string }
): Promise<any> {
  const size = 5
  const chunks: string[] = []
  for (let i = 0; i < input.text.length; i += size) {
    chunks.push(input.text.slice(i, i + size))
  }
  if (chunks.length === 0) {
    chunks.push('')
  }
  let answer: any
  for (let index = 0; index < chunks.length; index++) {
    const last = index === chunks.length - 1
    answer = await worker.request(
      'phpantom.open',
      {
        docId: input.docId,
        language: input.language,
        workspaceId: input.workspaceId,
        branch: null,
        displayName: null,
        index,
        chunk: chunks[index],
        last,
        ...(input.resync ? { resync: true } : {})
      },
      input.panel ?? 'panel-1'
    )
    if (!last) {
      assert.deepEqual(answer, { state: 'pending' })
    }
  }
  return answer
}

async function until(condition: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const diagnosticsFor = (posts: Post[], docId: string) => posts.filter((p) => p.event === 'phpantom.diagnostics' && p.payload.docId === docId)
const at = (line: number, character: number) => ({ line, character })

test('attaches a document and answers hover through the server', async () => {
  const { worker, docs } = await setup({ files: { 'a/app/A.php': '<?php // ok\n' } })
  const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  assert.equal(status.state, 'ready')
  assert.equal(status.uri, pathToFileURL(docs['a/app/A.php']).href)
  assert.deepEqual(await worker.request('phpantom.request', { docId: 'd1', session: status.session, method: 'textDocument/hover', params: { position: { line: 0, character: 1 } } }), { result: { contents: { kind: 'markdown', value: 'len=12' } } })
})

test('a gap in versions asks for a resync', async () => {
  const { worker } = await setup({ files: { 'a/A.php': '<?php // ok\n' } })
  const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  const change = { range: { start: at(0, 0), end: at(0, 0) }, text: 'x' }
  assert.deepEqual(await worker.request('phpantom.change', { docId: 'd1', session: status.session, version: 3, changes: [change], length: 13 }), { resync: true })
})

test('a resync open resends the whole text and restarts the versions', async () => {
  const { worker, started } = await setup({ files: { 'a/A.php': '<?php // ok\n' } })
  const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  const again = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // edited\n', resync: true })
  assert.equal(again.state, 'ready')
  assert.equal(again.uri, status.uri)
  assert.equal(started.length, 1)
  const sent = started[0].server.notified.filter((n) => n.method.startsWith('textDocument/'))
  assert.deepEqual(sent.map((n) => n.method), ['textDocument/didOpen', 'textDocument/didChange'])
  assert.deepEqual(sent[1].params.contentChanges, [{ text: '<?php // edited\n' }])
  const change = { range: { start: at(0, 0), end: at(0, 0) }, text: 'x' }
  assert.deepEqual(await worker.request('phpantom.change', { docId: 'd1', session: status.session, version: 2, changes: [change], length: 17 }), { ok: true })
  assert.deepEqual(await worker.request('phpantom.request', { docId: 'd1', session: status.session, method: 'textDocument/hover', params: { position: at(0, 0) } }), { result: { contents: { kind: 'markdown', value: 'len=17' } } })
})

test('re-opening a docId closes the old attachment', async () => {
  const text = '<?php BAD\n'
  const { worker, started, posts } = await setup({ files: { 'a/A.php': text, 'b/A.php': text } })
  const first = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text })
  const second = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-b', text })
  assert.equal(first.state, 'ready')
  assert.equal(second.state, 'ready')
  assert.notEqual(first.uri, second.uri)
  assert.equal(started.length, 2)
  const [serverA, serverB] = started
  assert.ok(serverA.server.notified.some((n) => n.method === 'textDocument/didClose' && n.params.textDocument.uri === first.uri))
  assert.ok(!serverB.server.notified.some((n) => n.method === 'textDocument/didClose'))
  await until(() => diagnosticsFor(posts, 'd1').length > 0)
  await sleep(300)
  posts.length = 0
  serverA.events.diagnostics(first.uri, [{ range: { start: at(0, 6), end: at(0, 9) }, message: 'bad', severity: 1 }])
  await sleep(300)
  assert.equal(diagnosticsFor(posts, 'd1').length, 0)
  serverB.events.diagnostics(second.uri, [])
  await until(() => diagnosticsFor(posts, 'd1').length === 1)
})

test('a length mismatch asks for a resync', async () => {
  const { worker } = await setup({ files: { 'a/A.php': '<?php // ok\n' } })
  const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  const change = { range: { start: at(0, 0), end: at(0, 0) }, text: 'x' }
  assert.deepEqual(await worker.request('phpantom.change', { docId: 'd1', session: status.session, version: 2, changes: [change], length: 14 }), { resync: true })
})

test('posts diagnostics only for attached documents', async () => {
  const { worker, posts, started } = await setup({ files: { 'a/A.php': '<?php BAD\n' } })
  const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php BAD\n' })
  await until(() => diagnosticsFor(posts, 'd1').length === 1)
  const post = diagnosticsFor(posts, 'd1')[0]
  assert.equal(post.panel, 'panel-1')
  assert.equal(post.payload.diagnostics.length, 1)
  assert.equal(post.payload.truncated, 0)
  const other = pathToFileURL(join(dirname(fileURLToPath(status.uri)), 'Other.php')).href
  started[0].events.diagnostics(other, [{ range: { start: at(0, 0), end: at(0, 1) }, message: 'elsewhere', severity: 1 }])
  await sleep(300)
  assert.equal(posts.filter((p) => p.event === 'phpantom.diagnostics').length, 1)
})

test('answers detached after a server crash', async () => {
  const { worker, posts } = await setup({ files: { 'a/A.php': '<?php // ok\n' } })
  const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  const change = { range: { start: at(0, 0), end: at(0, 0) }, text: 'CRASH' }
  assert.deepEqual(await worker.request('phpantom.change', { docId: 'd1', session: status.session, version: 2, changes: [change], length: 17 }), { ok: true })
  await until(() => posts.some((p) => p.event === 'phpantom.status' && p.payload.docId === 'd1' && p.payload.state === 'error'))
  const post = posts.find((p) => p.event === 'phpantom.status')!
  assert.equal(post.panel, 'panel-1')
  assert.deepEqual(await worker.request('phpantom.request', { docId: 'd1', session: status.session, method: 'textDocument/hover', params: { position: at(0, 0) } }), { detached: true })
  assert.deepEqual(await worker.request('phpantom.change', { docId: 'd1', session: status.session, version: 3, changes: [], length: 17 }), { detached: true })
})

test('a crashed root restarts on the next open, at most 3 times in 5 minutes', async () => {
  const text = '<?php // ok\n'
  const { worker, posts, started } = await setup({ files: { 'a/A.php': text } })
  const crash = { range: { start: at(0, 0), end: at(0, 0) }, text: 'CRASH' }
  for (let round = 0; round < 4; round++) {
    const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text })
    assert.equal(status.state, 'ready', `round ${round}`)
    await worker.request('phpantom.change', { docId: 'd1', session: status.session, version: 2, changes: [crash], length: 17 })
    await until(() => posts.filter((p) => p.event === 'phpantom.status').length === round + 1)
  }
  assert.equal(started.length, 4)
  const after = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text })
  assert.equal(after.state, 'error')
  assert.equal(started.length, 4)
})

test('a new worker session makes old documents detached', async () => {
  const { worker } = await setup({ files: { 'a/A.php': '<?php // ok\n' } })
  const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  assert.notEqual(status.session, 'an-older-session')
  assert.deepEqual(await worker.request('phpantom.request', { docId: 'd1', session: 'an-older-session', method: 'textDocument/hover', params: {} }), { detached: true })
  assert.deepEqual(await worker.request('phpantom.request', { docId: 'unknown', session: status.session, method: 'textDocument/hover', params: {} }), { detached: true })
  assert.deepEqual(await worker.request('phpantom.navigate', { docId: 'd1', session: 'an-older-session', uri: status.uri, range: { start: at(0, 0), end: at(0, 0) } }), { opened: false, reason: 'failed' })
  const peek = await worker.request('phpantom.peek', { docId: 'd1', session: 'an-older-session', uris: [status.uri] })
  assert.deepEqual(peek.files, [])
})

test('a remote focused workspace is never attached', async () => {
  const { worker, started } = await setup({
    files: { 'a/A.php': '<?php // ok\n' },
    rows: (dir) => [
      { id: 'ws-r', name: 'box', branch: 'main', path: '/srv/app', hostId: 'ssh:box' },
      { id: 'ws-a', name: 'a', branch: 'main', path: join(dir, 'a'), hostId: 'local' }
    ]
  })
  assert.deepEqual(await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-r', text: '<?php // ok\n' }), { state: 'remote', host: 'ssh:box' })
  assert.equal(started.length, 0)
})

test('a file found nowhere is single-file', async () => {
  const { worker, started } = await setup({ files: { 'a/A.php': '<?php // ok\n' } })
  assert.deepEqual(await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // nowhere at all\n' }), { state: 'single-file', reason: 'no-file' })
  assert.equal(started.length, 0)
})

test('navigate stores a reveal that the next open of that file picks up', async () => {
  const yText = '<?php\nclass Y {}\n'
  const { worker, docs, opened, posts } = await setup({
    files: { 'a/composer.json': '{}', 'a/app/A.php': '<?php // ok\n', 'a/vendor/x/Y.php': yText }
  })
  const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  const range: LspRange = { start: at(1, 6), end: at(1, 7) }
  const target = pathToFileURL(docs['a/vendor/x/Y.php']).href
  assert.deepEqual(await worker.request('phpantom.navigate', { docId: 'd1', session: status.session, uri: target, range }), { opened: true })
  assert.deepEqual(opened, [{ workspaceId: 'ws-a', path: 'vendor/x/Y.php' }])
  const second = await openWhole(worker, { docId: 'd2', language: 'php', workspaceId: 'ws-a', text: yText, panel: 'panel-2' })
  assert.equal(second.state, 'ready')
  assert.equal(second.uri, target)
  assert.deepEqual(second.reveal, range)

  // Already open in another tab: that tab is told, and editor.open still focuses it.
  assert.deepEqual(await worker.request('phpantom.navigate', { docId: 'd1', session: status.session, uri: target, range }), { opened: true })
  await until(() => posts.some((p) => p.event === 'phpantom.reveal'))
  assert.deepEqual(posts.find((p) => p.event === 'phpantom.reveal'), { event: 'phpantom.reveal', payload: { docId: 'd2', range }, panel: 'panel-2' })
  assert.equal(opened.length, 2)

  assert.deepEqual(await worker.request('phpantom.navigate', { docId: 'd1', session: status.session, uri: 'https://example.com/x.php', range }), { opened: false, reason: 'not-a-file' })
  assert.deepEqual(await worker.request('phpantom.navigate', { docId: 'd1', session: status.session, uri: 'file:///nowhere/x.php', range }), { opened: false, reason: 'outside-workspace' })
  assert.deepEqual(await worker.request('phpantom.navigate', { docId: 'd1', session: status.session, uri: pathToFileURL(join(dirname(docs['a/app/A.php']), 'Missing.php')).href, range }), { opened: false, reason: 'failed' })
})

test('peek reads files in order and counts the rest', async () => {
  const files: Record<string, string> = { 'a/A.php': '<?php // ok\n' }
  for (let i = 0; i < 30; i++) {
    files[`a/p/F${i}.php`] = `<?php // ${i}\n`
  }
  const { worker, docs } = await setup({ files })
  const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  const uris = Array.from({ length: 30 }, (_, i) => pathToFileURL(docs[`a/p/F${i}.php`]).href)
  const peek = await worker.request('phpantom.peek', { docId: 'd1', session: status.session, uris })
  assert.equal(peek.files.length, 25)
  assert.equal(peek.omitted, 5)
  assert.deepEqual(peek.files[3], { uri: uris[3], text: '<?php // 3\n' })
})

test('truncates an oversized completion list', async () => {
  const { worker } = await setup({ files: { 'a/A.php': '<?php // ok\n' } })
  const status = await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  const answer = await worker.request('phpantom.request', { docId: 'd1', session: status.session, method: 'textDocument/completion', params: { position: at(0, 5) } })
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) < 1024 * 1024)
  assert.equal(answer.result.isIncomplete, true)
  assert.ok(answer.result.items.length > 1000 && answer.result.items.length < 5000)
  assert.equal(answer.result.items[0].label, 'item0')
})

test('stops an idle server after the idle time', async () => {
  const { worker, started } = await setup({ files: { 'a/A.php': '<?php // ok\n' }, idleMs: 50 })
  await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  assert.equal(started[0].server.alive, true)
  assert.deepEqual(await worker.request('phpantom.close', { docId: 'd1' }), { ok: true })
  assert.ok(started[0].server.notified.some((n) => n.method === 'textDocument/didClose'))
  await until(() => !started[0].server.alive)
})

test('reports the status bar at most once a second, ending on the latest state', async () => {
  const { worker, statuses } = await setup({ files: { 'a/A.php': '<?php // ok\n' } })
  await openWhole(worker, { docId: 'd1', language: 'php', workspaceId: 'ws-a', text: '<?php // ok\n' })
  await sleep(1200)
  assert.ok(statuses.length >= 1 && statuses.length <= 3, `saw ${statuses.length} updates`)
  assert.equal(statuses.at(-1)?.icon, 'check')
  assert.match(statuses.at(-1)!.tooltip, /1\.1\.0/)
})
