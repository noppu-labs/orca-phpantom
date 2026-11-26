import { assert, test } from 'orca/testing'
import { DocumentMirror } from '../../src/lsp/mirror.ts'
import type { AttachStatus } from '../../src/protocol.ts'
import { LspBridge, type BridgeHost, type WorkspaceContext } from './bridge.ts'
import { source } from './fake-source.test-helper.ts'
import { encodedSize } from './split.ts'

// Short timings so the tests run in milliseconds; the defaults are the brief's (seconds).
const FAST = { syncDelayMs: 5, retryGapMs: 30, quietMs: 10, saveDelayMs: 25, reattachGapMs: 0, mountWindowMs: 80, settleMs: 60 }

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await wait(2)
  }
}

const ctx = (workspaceId: string): WorkspaceContext => ({ workspaceId, branch: workspaceId, displayName: workspaceId })

type Call = { name: string; input: any; options?: { timeoutMs?: number; signal?: AbortSignal } }
type OpenHandler = (input: any, host: FakeHost) => AttachStatus | Promise<AttachStatus>
type Answer = unknown | Promise<unknown>

/** Pending until the last chunk, then ready under the host's current session. */
function readyOn(_when: 'last'): OpenHandler {
  return (input, host) => (input.last ? host.ready() : { state: 'pending' })
}

type FakeHost = BridgeHost & {
  calls(name: string): Call[]
  /** What the router would do with each request; replace to script answers. */
  handlers: {
    open: OpenHandler
    change: (input: any, host: FakeHost) => Answer
    request: (input: any, host: FakeHost) => Answer
    ping: (input: any, host: FakeHost) => Answer
  }
  session: string
  context: WorkspaceContext | null
  /** The worker's copy of the document: set by a ready answer, moved by accepted changes. */
  mirror: DocumentMirror | null
  version: number
  /** Broken router rules: chunks out of order, a version gap, a wrong length. Tests expect none. */
  violations: string[]
  maxInFlight: Record<string, number>
  ready(): AttachStatus
  restart(session: string): void
  post(event: string, payload: unknown): void
  workspaceChanged(context: WorkspaceContext | null): void
  firstInput(): void
  visible(): void
  saved(): void
  settingsChanged(): void
}

function fakeHost(handlers: Partial<FakeHost['handlers']> = {}, context: WorkspaceContext | null = ctx('ws-a')): FakeHost {
  const calls: Call[] = []
  const listeners = new Map<string, Set<(payload: any) => void>>()
  const subscribe = (event: string, listener: (payload: any) => void) => {
    const set = listeners.get(event) ?? new Set()
    listeners.set(event, set)
    set.add(listener)
    return { dispose: () => void set.delete(listener) }
  }
  const emit = (event: string, payload?: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
  }
  const inFlight: Record<string, number> = {}
  let chunks: string[] | null = null
  let assembled = ''
  let openedIn: string | null = null
  const host: FakeHost = {
    handlers: {
      open: readyOn('last'),
      change: (input, self) => {
        if (!self.mirror || input.session !== self.session) return { detached: true }
        if (input.version !== self.version + 1) {
          self.violations.push(`version ${input.version} after ${self.version}`)
          return { resync: true }
        }
        self.mirror.apply(input.changes)
        if (self.mirror.length !== input.length) {
          self.violations.push(`length ${input.length}, mirror ${self.mirror.length}`)
          return { resync: true }
        }
        self.version = input.version
        return { ok: true }
      },
      request: (input, self) => (self.mirror && input.session === self.session ? { result: `answer to ${input.method}` } : { detached: true }),
      ping: (input, self) => (self.mirror && input.session === self.session ? { ok: true } : { detached: true }),
      ...handlers
    },
    session: 's1',
    context,
    mirror: null,
    version: 0,
    violations: [],
    maxInFlight: inFlight,
    calls: (name) => calls.filter((call) => call.name === name),
    ready() {
      host.mirror = new DocumentMirror(assembled)
      host.version = 1
      // Each workspace has its own copy of the file, as sibling worktrees do.
      return { state: 'ready', session: host.session, uri: `file:///${openedIn ?? 'none'}/app/A.php`, capabilities: {} }
    },
    restart(session) {
      host.session = session
      host.mirror = null
    },
    async request(name: string, input: any, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<any> {
      calls.push({ name, input, ...(options ? { options } : {}) })
      const key = `${name}:now`
      inFlight[key] = (inFlight[key] ?? 0) + 1
      inFlight[name] = Math.max(inFlight[name] ?? 0, inFlight[key])
      try {
        await wait(1)
        if (name === 'phpantom.open') {
          if (input.index === 0) chunks = []
          if (!chunks || chunks.length !== input.index) {
            host.violations.push(`chunk ${input.index} out of order`)
            chunks = null
            return { state: 'error', message: 'out of order' }
          }
          chunks.push(input.chunk)
          openedIn = input.workspaceId
          if (input.last) {
            assembled = chunks.join('')
            chunks = null
          }
          return await host.handlers.open(input, host)
        }
        if (name === 'phpantom.change') return await host.handlers.change(input, host)
        if (name === 'phpantom.request') return await host.handlers.request(input, host)
        if (name === 'phpantom.ping') return await host.handlers.ping(input, host)
        return { ok: true }
      } finally {
        inFlight[key] -= 1
      }
    },
    on: subscribe,
    readContext: async () => host.context,
    onWorkspaceChanged: (listener) => subscribe('workspace.changed', listener),
    onFirstInput: (listener) => subscribe('first-input', listener),
    onVisible: (listener) => subscribe('visible', listener),
    onSaved: (listener) => subscribe('saved', listener),
    onSettingsChanged: (listener) => subscribe('settings', listener),
    post: (event, payload) => emit(event, payload),
    workspaceChanged: (next) => emit('workspace.changed', next),
    firstInput: () => emit('first-input'),
    visible: () => emit('visible'),
    saved: () => emit('saved'),
    settingsChanged: () => emit('settings')
  }
  return host
}

const versions = (host: FakeHost): number[] => host.calls('phpantom.change').map((call) => call.input.version)
const fullOpens = (host: FakeHost) => host.calls('phpantom.open').filter((call) => call.input.index === 0 && !call.input.resync)

test('sends a large document in chunks and attaches', async () => {
  const host = fakeHost({ open: readyOn('last') })
  const bridge = new LspBridge(host, source('x'.repeat(200_000)))
  assert.equal((await bridge.attach()).state, 'ready')
  assert.ok(host.calls('phpantom.open').length > 1)
  assert.ok(host.calls('phpantom.open').every((c) => encodedSize(c.input) <= 64 * 1024))
  const opens = host.calls('phpantom.open')
  // Why 120 s on the last piece only: that one waits for the index or a download.
  assert.deepEqual(opens.map((c) => c.options?.timeoutMs), [...opens.slice(1).map(() => undefined), 120_000])
  assert.deepEqual(opens.map((c) => c.input.workspaceId), opens.map(() => 'ws-a'))
  assert.equal(host.mirror?.text, 'x'.repeat(200_000))
  assert.equal(host.maxInFlight['phpantom.open'], 1)
  bridge.dispose()
})

test('keeps edits typed while attach is in flight', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const host = fakeHost({
    open: async (input, self) => {
      if (!input.last) return { state: 'pending' }
      await gate
      return self.ready()
    }
  })
  const doc = source('<?php\necho 1;\n')
  const bridge = new LspBridge(host, doc, FAST)
  const attached = bridge.attach()
  await until(() => host.calls('phpantom.open').length === 1, 'the open')
  doc.edit(11, 12, '2')
  doc.edit(11, 12, '3')
  await wait(20)
  assert.equal(host.calls('phpantom.change').length, 0)
  release()
  assert.equal((await attached).state, 'ready')
  await until(() => host.mirror?.text === doc.text, 'the worker to catch up')
  assert.deepEqual(versions(host), [2, 3])
  assert.equal(host.mirror?.text, '<?php\necho 3;\n')
  assert.deepEqual(host.violations, [])
  bridge.dispose()
})

test('sends changes in order with consecutive versions', async () => {
  const host = fakeHost()
  const base = host.handlers.change
  host.handlers.change = async (input, self) => {
    await wait(8)
    return base(input, self)
  }
  const doc = source('<?php\n$a = 1;\n')
  const bridge = new LspBridge(host, doc, FAST)
  await bridge.attach()
  doc.edit(11, 12, '2')
  doc.edit(11, 12, '3')
  await wait(1)
  doc.edit(12, 12, '4')
  await until(() => host.calls('phpantom.change').length === 3, 'three changes')
  await until(() => host.mirror?.text === doc.text, 'the worker to catch up')
  assert.deepEqual(versions(host), [2, 3, 4])
  assert.equal(host.maxInFlight['phpantom.change'], 1)
  assert.deepEqual(host.violations, [])
  bridge.dispose()
})

test('a paste larger than one request reaches the worker split and intact', async () => {
  const host = fakeHost()
  const doc = source('<?php\n// one\n// two\n')
  const bridge = new LspBridge(host, doc, FAST)
  await bridge.attach()
  // Two cursors, each pasting 70 KB: one event whose changes must be split across requests.
  doc.editMany([
    [9, 9, 'é😀"\\\n'.repeat(10_000)],
    [16, 16, 'abc\n'.repeat(18_000)]
  ])
  await until(() => host.mirror?.text === doc.text, 'the worker to hold the pasted text')
  assert.ok(host.calls('phpantom.change').length > 2)
  assert.ok(host.calls('phpantom.change').every((c) => encodedSize(c.input) <= 64 * 1024))
  assert.equal(host.calls('phpantom.open').filter((c) => c.input.resync).length, 0)
  assert.deepEqual(host.violations, [])
  bridge.dispose()
})

test('a resync answer sends the whole text again', async () => {
  const host = fakeHost()
  const doc = source('<?php\n$a = 1;\n')
  const bridge = new LspBridge(host, doc, FAST)
  await bridge.attach()
  host.handlers.change = () => ({ resync: true })
  doc.edit(11, 12, '2')
  await until(() => host.mirror?.text === doc.text, 'the worker to hold the whole text again')
  const resync = host.calls('phpantom.open').find((c) => c.input.resync === true)
  assert.equal(resync?.input.chunk, '<?php\n$a = 2;\n')
  assert.equal(resync?.input.index, 0)
  assert.equal(host.mirror?.text, doc.text)
  bridge.dispose()
})

test('replacing the whole text resyncs instead of sending a change', async () => {
  const host = fakeHost()
  const doc = source('<?php\n')
  const bridge = new LspBridge(host, doc, FAST)
  await bridge.attach()
  doc.replaceAll('<?php\necho "new";\n')
  await until(() => host.mirror?.text === doc.text, 'the worker to hold the new text')
  assert.equal(host.calls('phpantom.open').filter((c) => c.input.resync === true).length, 1)
  assert.equal(host.calls('phpantom.change').length, 0)
  assert.equal(host.mirror?.text, doc.text)
  doc.edit(6, 6, '// ')
  await until(() => host.mirror?.text === doc.text, 'the next edit')
  assert.deepEqual(versions(host), [2])
  bridge.dispose()
})

test('re-opens after the worker reports a new session', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  const ready: string[] = []
  bridge.onReady((status) => ready.push(status.session))
  host.restart('s2')
  const answer = await bridge.ask('textDocument/hover', { position: { line: 0, character: 1 } })
  assert.equal(answer, 'answer to textDocument/hover')
  assert.equal(fullOpens(host).length, 2)
  const requests = host.calls('phpantom.request')
  assert.deepEqual(requests.map((c) => c.input.session), ['s1', 's2'])
  assert.deepEqual(ready, ['s2'])
  bridge.dispose()
})

test('an unavailable worker is re-attached', async () => {
  const host = fakeHost()
  const doc = source('<?php\n')
  const bridge = new LspBridge(host, doc, FAST)
  await bridge.attach()
  host.restart('s2')
  host.handlers.change = () => {
    host.handlers.change = fakeHost().handlers.change
    throw Object.assign(new Error('no worker'), { code: 'unavailable' })
  }
  doc.edit(6, 6, 'echo 1;')
  await until(() => fullOpens(host).length === 2 && host.mirror?.text === doc.text, 'a fresh open with the new text')
  assert.equal(bridge.status?.state, 'ready')
  bridge.dispose()
})

test('re-attaches when the worker says its server restarted', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  const diagnostics: unknown[][] = []
  bridge.onDiagnostics((list) => diagnostics.push(list))
  host.restart('s1')
  host.post('phpantom.status', { docId: 'someone-else', state: 'restarting' })
  await wait(20)
  assert.equal(fullOpens(host).length, 1)
  host.post('phpantom.status', { docId: bridge.docId, state: 'restarting' })
  await until(() => fullOpens(host).length === 2, 'a fresh open')
  assert.deepEqual(diagnostics[0], [])
  bridge.dispose()
})

test('re-attaches when the tab shows under another workspace', async () => {
  // R2: readContext is stale for up to 1.3 s after a tab mounts; workspace.changed brings the truth.
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  assert.equal((await bridge.attach()).state, 'ready')
  host.context = ctx('ws-b')
  host.workspaceChanged(ctx('ws-b'))
  await until(() => fullOpens(host).length === 2, 'a second full open')
  assert.equal(fullOpens(host)[1].input.workspaceId, 'ws-b')
  assert.equal(fullOpens(host)[1].input.branch, 'ws-b')
  await until(() => bridge.status?.state === 'ready', 'ready again')
  // Only once: another change in the window does not move it again.
  host.workspaceChanged(ctx('ws-c'))
  await wait(30)
  assert.equal(fullOpens(host).length, 2)
  bridge.dispose()
})

test('confirms the workspace on first input', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  await wait(FAST.mountWindowMs + 10)
  // A later workspace.changed (the person switched to this tab) is not a reason by itself.
  host.context = ctx('ws-b')
  const changedAt = Date.now()
  host.workspaceChanged(ctx('ws-b'))
  await wait(10)
  assert.equal(fullOpens(host).length, 1)
  // Input in this frame proves it is on screen; the context is read settleMs after the last switch.
  host.firstInput()
  await until(() => fullOpens(host).length === 2, 'a re-attach after first input')
  assert.ok(Date.now() - changedAt >= FAST.settleMs, 'waited for the context to settle')
  assert.equal(fullOpens(host)[1].input.workspaceId, 'ws-b')
  bridge.dispose()
})

test('first input in the same workspace keeps the attach', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  host.firstInput()
  await wait(FAST.mountWindowMs + FAST.settleMs + 20)
  assert.equal(fullOpens(host).length, 1)
  bridge.dispose()
})

test('ignores focus changes after it settled', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  host.firstInput()
  await wait(FAST.mountWindowMs + FAST.settleMs + 20)
  assert.equal(fullOpens(host).length, 1)
  // A background frame keeps hearing every switch; none of these may move it.
  host.context = ctx('ws-b')
  host.workspaceChanged(ctx('ws-b'))
  host.visible()
  host.firstInput()
  await wait(FAST.settleMs + 40)
  assert.equal(fullOpens(host).length, 1)
  bridge.dispose()
})

test('never interleaves two chunk sequences for one document', async () => {
  const host = fakeHost({
    open: async (input, self) => {
      await wait(5)
      return input.last ? self.ready() : { state: 'pending' }
    }
  })
  const text = 'y'.repeat(300_000)
  const bridge = new LspBridge(host, source(text), FAST)
  let readies = 0
  bridge.onReady(() => (readies += 1))
  const attached = bridge.attach()
  await until(() => host.calls('phpantom.open').length === 2, 'the second chunk')
  host.workspaceChanged(ctx('ws-b'))
  assert.equal((await attached).state, 'ready')
  await until(() => bridge.status?.state === 'ready' && fullOpens(host).length === 2 && host.calls('phpantom.open').at(-1)?.input.last === true, 'the re-attach')
  assert.deepEqual(host.violations, [])
  assert.equal(host.maxInFlight['phpantom.open'], 1)
  assert.equal(host.calls('phpantom.open').at(-1)?.input.workspaceId, 'ws-b')
  assert.equal(host.mirror?.text, text)
  // The first sequence stopped at the next chunk, and nothing it answered counted.
  const opens = host.calls('phpantom.open')
  const second = opens.findIndex((c, i) => i > 0 && c.input.index === 0)
  assert.ok(second < opens.length - second, `the first sequence sent ${second} of ${opens.length - second} chunks`)
  assert.equal(readies, 1)
  bridge.dispose()
})

test('drops a formatting result when the text changed meanwhile', async () => {
  const host = fakeHost()
  const doc = source('<?php\n$a=1;\n')
  const bridge = new LspBridge(host, doc, FAST)
  await bridge.attach()
  host.handlers.request = async (input) => {
    doc.edit(6, 6, ' ')
    await wait(2)
    return { result: [{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, newText: 'formatted' }], method: input.method }
  }
  assert.equal(await bridge.ask('textDocument/formatting', { options: { tabSize: 4, insertSpaces: true } }), null)
  // A hover is still worth showing after an edit.
  assert.notEqual(await bridge.ask('textDocument/hover', { position: { line: 1, character: 1 } }), null)
  bridge.dispose()
})

test('drops an answer from the attachment a re-target replaced', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  host.handlers.request = async () => {
    // The tab turns out to be the sibling worktree's while the answer is on its way.
    host.workspaceChanged(ctx('ws-b'))
    await until(() => bridge.status?.state === 'ready' && fullOpens(host).length === 2, 'the re-attach')
    return { result: 'from ws-a' }
  }
  assert.equal(await bridge.ask('textDocument/hover', {}), null)
  bridge.dispose()
})

test('a request flushes the edits typed before it', async () => {
  const host = fakeHost()
  const doc = source('<?php\n')
  const bridge = new LspBridge(host, doc, { ...FAST, syncDelayMs: 10_000 })
  await bridge.attach()
  doc.edit(6, 6, '$x->')
  let seen = ''
  host.handlers.request = (_input, self) => {
    seen = self.mirror?.text ?? ''
    return { result: null }
  }
  await bridge.ask('textDocument/completion', { position: { line: 1, character: 4 } })
  assert.equal(seen, '<?php\n$x->')
  bridge.dispose()
})

test('an aborted request answers null', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  const controller = new AbortController()
  host.handlers.request = async () => {
    controller.abort()
    return { result: 'late' }
  }
  assert.equal(await bridge.ask('textDocument/hover', {}, controller.signal), null)
  assert.equal(host.calls('phpantom.request')[0].options?.signal, controller.signal)
  bridge.dispose()
})

test('a request can carry a longer timeout, and carries no options when it has none', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  const controller = new AbortController()
  await bridge.ask('textDocument/formatting', {}, controller.signal, { timeoutMs: 30_000 })
  await bridge.ask('textDocument/rangeFormatting', {}, undefined, { timeoutMs: 30_000 })
  await bridge.ask('textDocument/hover', {})
  const [withBoth, timeoutOnly, bare] = host.calls('phpantom.request')
  assert.deepEqual(withBoth.options, { signal: controller.signal, timeoutMs: 30_000 })
  assert.deepEqual(timeoutOnly.options, { timeoutMs: 30_000 })
  assert.equal(bare.options, undefined)
  bridge.dispose()
})

test('navigate and peek go out under the current session, and answer null before an attach', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  const range = { start: { line: 3, character: 6 }, end: { line: 3, character: 6 } }
  assert.equal(await bridge.navigate('file:///ws-a/app/B.php', range), null)
  assert.equal(await bridge.peek(['file:///ws-a/app/B.php']), null)
  assert.equal(host.calls('phpantom.navigate').length + host.calls('phpantom.peek').length, 0)
  await bridge.attach()
  await bridge.navigate('file:///ws-a/app/B.php', range)
  await bridge.peek(['file:///ws-a/app/B.php'])
  assert.deepEqual(host.calls('phpantom.navigate')[0].input, { docId: bridge.docId, session: 's1', uri: 'file:///ws-a/app/B.php', range })
  assert.deepEqual(host.calls('phpantom.peek')[0].input, { docId: bridge.docId, session: 's1', uris: ['file:///ws-a/app/B.php'] })
  bridge.dispose()
})

test('a list the worker cut says how much was cut; ask still answers the list alone', async () => {
  const host = fakeHost({ request: () => ({ result: ['a', 'b'], truncated: 3 }) })
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  assert.deepEqual(await bridge.askDetailed('textDocument/references', {}), { result: ['a', 'b'], truncated: 3 })
  assert.deepEqual(await bridge.ask('textDocument/references', {}), ['a', 'b'])
  host.handlers.request = () => ({ result: null })
  assert.deepEqual(await bridge.askDetailed('textDocument/references', {}), { result: null, truncated: 0 })
  bridge.dispose()
})

test('retries a single-file attach after typing stops', async () => {
  let answers = 0
  const host = fakeHost({
    open: (input, self) => {
      if (!input.last) return { state: 'pending' }
      answers += 1
      return answers === 1 ? { state: 'single-file', reason: 'no-file' } : self.ready()
    }
  })
  const doc = source('<?php\n')
  const bridge = new LspBridge(host, doc, FAST)
  assert.equal((await bridge.attach()).state, 'single-file')
  await wait(FAST.retryGapMs + 20)
  // Nothing happened yet: a retry waits for typing to stop or the tab to show.
  assert.equal(fullOpens(host).length, 1)
  doc.edit(6, 6, 'echo 1;')
  await until(() => bridge.status?.state === 'ready', 'the retry to attach')
  assert.equal(fullOpens(host).length, 2)
  assert.equal(host.mirror?.text, doc.text)
  bridge.dispose()
})

test('gives up retrying after maxRetries', async () => {
  const host = fakeHost({ open: (input) => (input.last ? { state: 'single-file', reason: 'ambiguous' } : { state: 'pending' }) })
  const bridge = new LspBridge(host, source('<?php\n'), { ...FAST, retryGapMs: 1, quietMs: 1, maxRetries: 2 })
  await bridge.attach()
  for (let i = 0; i < 4; i++) {
    host.visible()
    await wait(15)
  }
  assert.equal(fullOpens(host).length, 3)
  bridge.dispose()
})

test('a save retries a single-file attach, even with the typing budget spent', async () => {
  let saved = false
  const host = fakeHost({ open: (input, self) => (!input.last ? { state: 'pending' } : saved ? self.ready() : { state: 'single-file', reason: 'no-file' }) })
  const doc = source('<?php\n')
  const bridge = new LspBridge(host, doc, { ...FAST, retryGapMs: 1, maxRetries: 1 })
  await bridge.attach()
  doc.edit(6, 6, 'a')
  await until(() => fullOpens(host).length === 2, 'the one typing retry')
  await wait(20)
  doc.edit(7, 7, 'b')
  await wait(FAST.quietMs + 30)
  assert.equal(fullOpens(host).length, 2, 'typing has no attempts left')
  // A save with no typing after it: the file is on disk now, so try once the save has landed.
  saved = true
  const savedAt = Date.now()
  host.saved()
  await until(() => bridge.status?.state === 'ready', 'the attach after the save')
  assert.ok(Date.now() - savedAt >= FAST.saveDelayMs, 'waited for the save to land')
  assert.equal(fullOpens(host).length, 3)
  bridge.dispose()
})

test('an error answer retries when the settings change', async () => {
  let fixed = false
  const host = fakeHost({ open: (input, self) => (!input.last ? { state: 'pending' } : fixed ? self.ready() : { state: 'error', message: 'PHPantom is not installed' }) })
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  const statuses: string[] = []
  bridge.onStatus((status) => statuses.push(status.state))
  assert.equal((await bridge.attach()).state, 'error')
  await wait(FAST.retryGapMs + 20)
  assert.equal(fullOpens(host).length, 1, 'an error waits for a reason to try again')
  fixed = true
  host.settingsChanged()
  await until(() => bridge.status?.state === 'ready', 'the attach after the settings change')
  // The error stayed the last word until the retry worked.
  assert.deepEqual(statuses, ['error', 'ready'])
  bridge.dispose()
})

test('an error answer retries when the tab shows', async () => {
  let answers = 0
  const host = fakeHost({ open: (input, self) => (!input.last ? { state: 'pending' } : ++answers === 1 ? { state: 'error', message: 'boom' } : self.ready()) })
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  host.visible()
  await until(() => bridge.status?.state === 'ready', 'the attach after the tab showed')
  bridge.dispose()
})

test('a remote file is not retried', async () => {
  const host = fakeHost({ open: (input) => (input.last ? { state: 'remote', host: 'box' } : { state: 'pending' }) })
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  host.saved()
  host.visible()
  await wait(FAST.retryGapMs + FAST.saveDelayMs + 30)
  assert.equal(fullOpens(host).length, 1)
  bridge.dispose()
})

test('a chunk sequence cut by a worker restart starts over', async () => {
  let cut = false
  const host = fakeHost({
    open: (input, self) => {
      if (input.index === 1 && !cut) {
        // The worker restarted: it no longer has chunk 0.
        cut = true
        return { state: 'error', message: `chunk 1 of ${input.docId} arrived out of order` }
      }
      return input.last ? self.ready() : { state: 'pending' }
    }
  })
  const text = 'z'.repeat(200_000)
  const bridge = new LspBridge(host, source(text), FAST)
  await bridge.attach()
  await until(() => bridge.status?.state === 'ready', 'a fresh sequence to attach')
  assert.equal(fullOpens(host).length, 2)
  assert.equal(host.mirror?.text, text)
  bridge.dispose()
})

test('a chunk the worker could not take starts the sequence over', async () => {
  let refused = false
  const host = fakeHost()
  const base = host.handlers.open
  host.handlers.open = (input, self) => {
    if (input.index === 1 && !refused) {
      refused = true
      throw Object.assign(new Error('no worker'), { code: 'unavailable' })
    }
    return base(input, self)
  }
  const bridge = new LspBridge(host, source('w'.repeat(200_000)), FAST)
  await bridge.attach()
  await until(() => bridge.status?.state === 'ready', 'a fresh sequence to attach')
  assert.equal(fullOpens(host).length, 2)
  bridge.dispose()
})

test('ignores events meant for another document', async () => {
  // R3: every frame of one editor shares a panel id, so posts can reach frames they are not for.
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  const diagnostics: unknown[][] = []
  const reveals: unknown[] = []
  const refreshes: string[][] = []
  bridge.onDiagnostics((list) => diagnostics.push(list))
  bridge.onReveal((range) => reveals.push(range))
  bridge.onRefresh((kinds) => refreshes.push(kinds))
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  host.post('phpantom.diagnostics', { docId: 'other', diagnostics: [{ message: 'not mine' }], truncated: 0 })
  host.post('phpantom.reveal', { docId: 'other', range })
  host.post('phpantom.diagnostics', { docId: bridge.docId, diagnostics: [{ message: 'mine' }], truncated: 0 })
  host.post('phpantom.reveal', { docId: bridge.docId, range })
  host.post('phpantom.refresh', { kinds: ['inlayHints'] })
  assert.deepEqual(diagnostics, [[{ message: 'mine' }]])
  assert.deepEqual(reveals, [range])
  assert.deepEqual(refreshes, [['inlayHints']])
  bridge.dispose()
})

test('reveals the range a ready answer carries', async () => {
  const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } }
  const host = fakeHost({ open: (input, self) => (input.last ? { ...self.ready(), reveal: range } : { state: 'pending' }) })
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  const reveals: unknown[] = []
  bridge.onReveal((r) => reveals.push(r))
  await bridge.attach()
  assert.deepEqual(reveals, [range])
  bridge.dispose()
})

test('closing the page closes the document', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), FAST)
  await bridge.attach()
  bridge.dispose()
  await until(() => host.calls('phpantom.close').length === 1, 'a close')
  assert.deepEqual(host.calls('phpantom.close')[0].input, { docId: bridge.docId })
})

test('pings while attached, and stops after dispose', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), { ...FAST, pingMs: 15 })
  await wait(40)
  // Nothing to renew before the first attach.
  assert.equal(host.calls('phpantom.ping').length, 0)
  await bridge.attach()
  await until(() => host.calls('phpantom.ping').length >= 3, 'three pings')
  assert.deepEqual(host.calls('phpantom.ping')[0].input, { docId: bridge.docId, session: 's1' })
  bridge.dispose()
  const sent = host.calls('phpantom.ping').length
  await wait(60)
  assert.equal(host.calls('phpantom.ping').length, sent)
})

test('does not ping a document that never attached', async () => {
  const host = fakeHost({ open: (input) => (input.last ? { state: 'remote', host: 'ssh:box' } : { state: 'pending' }) })
  const bridge = new LspBridge(host, source('<?php\n'), { ...FAST, pingMs: 10 })
  assert.equal((await bridge.attach()).state, 'remote')
  await wait(60)
  assert.equal(host.calls('phpantom.ping').length, 0)
  bridge.dispose()
})

test('a detached ping answer re-attaches', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), { ...FAST, pingMs: 15 })
  await bridge.attach()
  const ready: string[] = []
  bridge.onReady((status) => ready.push(status.session))
  // The worker released the document (its lease ran out) and now has another session.
  host.restart('s2')
  await until(() => ready.length === 1, 'a re-attach')
  assert.deepEqual(ready, ['s2'])
  assert.equal(fullOpens(host).length, 2)
  assert.equal(bridge.status?.state, 'ready')
  await until(() => host.calls('phpantom.ping').some((call) => call.input.session === 's2'), 'a ping under the new session')
  bridge.dispose()
})

test('an unavailable ping re-attaches; another failure keeps pinging', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), { ...FAST, pingMs: 15 })
  await bridge.attach()
  let failures = 0
  host.handlers.ping = () => {
    failures += 1
    if (failures === 1) throw Object.assign(new Error('timed out'), { code: 'timeout' })
    host.handlers.ping = fakeHost().handlers.ping
    throw Object.assign(new Error('no worker'), { code: 'unavailable' })
  }
  await until(() => fullOpens(host).length === 2, 'a re-attach')
  // The timeout alone did not re-attach: only the unavailable one did.
  assert.equal(failures, 2)
  await until(() => host.calls('phpantom.ping').length >= failures + 2, 'pinging again')
  assert.equal(bridge.status?.state, 'ready')
  bridge.dispose()
})

test('a ping carries a timeout no longer than the ping interval', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), { ...FAST, pingMs: 15 })
  await bridge.attach()
  await until(() => host.calls('phpantom.ping').length >= 1, 'a ping')
  assert.deepEqual(host.calls('phpantom.ping')[0].options, { timeoutMs: 15 })
  bridge.dispose()
})

test('a ping that never answers does not stop the pings of the next attach', async () => {
  const host = fakeHost()
  const bridge = new LspBridge(host, source('<?php\n'), { ...FAST, pingMs: 15 })
  await bridge.attach()
  const answers = host.handlers.ping
  host.handlers.ping = () => new Promise(() => undefined)
  await until(() => host.calls('phpantom.ping').length >= 1, 'a hung ping')
  host.handlers.ping = answers
  // The worker restarts: the bridge opens the document again and must ping under the new session.
  host.restart('s2')
  host.post('phpantom.status', { docId: bridge.docId, state: 'restarting' })
  await until(() => host.calls('phpantom.ping').some((call) => call.input.session === 's2'), 'a ping under the new session')
  bridge.dispose()
})
