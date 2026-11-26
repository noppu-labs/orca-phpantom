// The worker's switchboard: editors send `phpantom.*` requests, the router finds the file each
// document is, runs one PHPantom per composer root, forwards LSP traffic, and posts diagnostics
// and status back to the editors.
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PluginRequests } from 'orca'
import { resolveBinary, type Resolution } from './binary/resolve.ts'
import { locateFile } from './locate/locate.ts'
import { composerRoot, isLocal, resolveFocused, workspaceFor, type WorkspaceRow } from './locate/workspaces.ts'
import { DocumentMirror } from './lsp/mirror.ts'
import { PhpantomServer, type RefreshKind, type ServerEvents } from './lsp/server.ts'
import { sameUri } from './lsp/uri.ts'
import { Outbox } from './outbox.ts'
import type { AttachStatus } from './protocol.ts'
import { PendingReveals } from './reveals.ts'
import { aggregate, renderStatus, type ServerState, type StatusBarUpdate } from './status.ts'

export type RouterHost = {
  listWorkspaces(): Promise<WorkspaceRow[]>
  /** `path` is relative to the workspace, with forward slashes: `editor.open` refuses absolute paths. */
  openEditor(workspaceId: string, path: string): Promise<void>
  post(event: string, payload: unknown, options: { panel: string }): void
  status(update: StatusBarUpdate): void
  log(message: string): void
  settings(): Promise<{ phpantomPath: string; allowDownload: boolean }>
}

export type RouterOptions = {
  resolve?: typeof resolveBinary
  createServer?: (executable: string, root: string, events: ServerEvents) => PhpantomServer
  idleMs?: number
  sessionId?: string
}

type Input<K extends keyof PluginRequests> = PluginRequests[K]['input']
type Output<K extends keyof PluginRequests> = PluginRequests[K]['output']

type Entry = {
  root: string
  server: PhpantomServer | null
  starting: Promise<PhpantomServer> | null
  state: ServerState
  docs: Set<string>
  /** When this root was restarted after a crash, for the 3-in-5-minutes budget. */
  restarts: number[]
  crashed: boolean
  idle: ReturnType<typeof setTimeout> | null
}

type Doc = {
  docId: string
  panel: string
  uri: string
  path: string
  root: string
  workspace: WorkspaceRow
  server: PhpantomServer
  /** The editor's version, which restarts at 1 on a resync. */
  version: number
  /** What PHPantom is told; it only rises, so a resync never sends PHPantom an older version. */
  lspVersion: number
  mirror: DocumentMirror
  needsResync: boolean
  diagnostics: number
}

// Orca answers at most 1 MiB; the rest is room for the envelope.
const MAX_ANSWER_BYTES = 900 * 1024
const PEEK_MAX_FILES = 25
const PEEK_MAX_BYTES = 600 * 1024
const IDLE_MS = 10 * 60_000
const STATUS_INTERVAL_MS = 1000
const RESTART_WINDOW_MS = 5 * 60_000
const MAX_RESTARTS = 3

const SOURCE_WORDS: Record<string, string> = { setting: 'from settings', path: 'from PATH', cache: 'cached', download: 'downloaded' }

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class Router {
  readonly session: string
  private readonly host: RouterHost
  private readonly resolve: typeof resolveBinary
  private readonly createServer: (executable: string, root: string, events: ServerEvents) => PhpantomServer
  private readonly idleMs: number
  private readonly outbox: Outbox
  private readonly reveals = new PendingReveals()
  private readonly pool = new Map<string, Entry>()
  private readonly docs = new Map<string, Doc>()
  private readonly chunks = new Map<string, string[]>()
  private readonly lanes = new Map<string, Promise<void>>()
  private resolution: Promise<Resolution> | null = null
  private resolved: Resolution | null = null
  private downloading = false
  private resolveError: string | null = null
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private lastStatusAt = 0
  private lastStatus = ''
  private disposed = false

  constructor(host: RouterHost, options: RouterOptions = {}) {
    this.host = host
    this.resolve = options.resolve ?? resolveBinary
    this.createServer = options.createServer ?? ((executable, root, events) => new PhpantomServer({ executable, root, events }))
    this.idleMs = options.idleMs ?? IDLE_MS
    this.session = options.sessionId ?? randomUUID()
    this.outbox = new Outbox((event, payload, postOptions) => host.post(event, payload, postOptions))
  }

  async open(input: Input<'phpantom.open'>, caller: { panel: string }): Promise<AttachStatus> {
    if (input.index === 0) {
      this.chunks.set(input.docId, [])
    }
    const parts = this.chunks.get(input.docId)
    if (!parts || parts.length !== input.index) {
      this.chunks.delete(input.docId)
      return { state: 'error', message: `chunk ${input.index} of ${input.docId} arrived out of order` }
    }
    parts.push(input.chunk)
    if (!input.last) {
      return { state: 'pending' }
    }
    this.chunks.delete(input.docId)
    const text = parts.join('')
    // Why one lane per document: a re-attach can arrive while the first open is still locating or starting.
    return this.inLane(input.docId, () => this.attach(input, text, caller.panel))
  }

  async change(input: Input<'phpantom.change'>): Promise<Output<'phpantom.change'>> {
    const doc = this.attached(input.docId, input.session)
    if (!doc) {
      return { detached: true }
    }
    if (doc.needsResync || input.version !== doc.version + 1) {
      return { resync: true }
    }
    doc.mirror.apply(input.changes)
    if (doc.mirror.length !== input.length) {
      doc.needsResync = true
      return { resync: true }
    }
    doc.version = input.version
    doc.lspVersion += 1
    doc.server.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.lspVersion }, contentChanges: input.changes })
    return { ok: true }
  }

  async request(input: Input<'phpantom.request'>, signal: AbortSignal): Promise<Output<'phpantom.request'>> {
    const doc = this.attached(input.docId, input.session)
    if (!doc) {
      return { detached: true }
    }
    const params = input.method.startsWith('textDocument/') ? { ...input.params, textDocument: { uri: doc.uri } } : input.params
    let result: unknown
    try {
      result = (await doc.server.request(input.method, params, signal)) ?? null
    } catch (error) {
      // Why: a request that failed because its server died is a detach, not an answer from PHPantom.
      return doc.server.alive ? { error: messageOf(error) } : { detached: true }
    }
    return this.fitAnswer(input.method, result)
  }

  close(input: Input<'phpantom.close'>): Promise<Output<'phpantom.close'>> {
    this.chunks.delete(input.docId)
    return this.inLane(input.docId, async () => {
      const doc = this.docs.get(input.docId)
      if (doc) {
        this.detach(doc)
      }
      return { ok: true }
    })
  }

  async navigate(input: Input<'phpantom.navigate'>): Promise<Output<'phpantom.navigate'>> {
    const doc = this.attached(input.docId, input.session)
    if (!doc) {
      return { opened: false, reason: 'failed' }
    }
    if (!/^file:/i.test(input.uri)) {
      return { opened: false, reason: 'not-a-file' }
    }
    let path: string
    try {
      path = fileURLToPath(input.uri)
    } catch {
      return { opened: false, reason: 'not-a-file' }
    }
    let row: WorkspaceRow | null = inside(doc.workspace.path, path) ? doc.workspace : null
    if (!row) {
      try {
        row = workspaceFor(path, await this.host.listWorkspaces())
      } catch (error) {
        this.host.log(`navigate: could not list workspaces: ${messageOf(error)}`)
        return { opened: false, reason: 'failed' }
      }
    }
    if (!row) {
      return { opened: false, reason: 'outside-workspace' }
    }
    // Why check here: editor.open opens a missing file without complaint.
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) {
      return { opened: false, reason: 'failed' }
    }
    this.reveals.add(path, input.range)
    for (const other of this.docs.values()) {
      if (other.docId !== doc.docId && sameUri(other.uri, input.uri)) {
        this.outbox.send(other.panel, `reveal:${other.docId}`, 'phpantom.reveal', { docId: other.docId, range: input.range })
      }
    }
    try {
      await this.host.openEditor(row.id, relative(row.path, path).split(sep).join('/'))
    } catch (error) {
      this.host.log(`navigate: editor.open failed: ${messageOf(error)}`)
      return { opened: false, reason: 'failed' }
    }
    return { opened: true }
  }

  async peek(input: Input<'phpantom.peek'>): Promise<Output<'phpantom.peek'>> {
    if (!this.attached(input.docId, input.session)) {
      return { files: [], omitted: input.uris.length }
    }
    const files: { uri: string; text: string }[] = []
    let total = 0
    for (const uri of input.uris) {
      if (files.length >= PEEK_MAX_FILES) {
        break
      }
      if (!/^file:/i.test(uri)) {
        continue
      }
      let text: string
      try {
        text = await readFile(fileURLToPath(uri), 'utf8')
      } catch {
        continue
      }
      // Why the JSON size: quotes and line breaks grow when the answer is encoded.
      const size = bytes(text)
      if (total + size > PEEK_MAX_BYTES) {
        break
      }
      total += size
      files.push({ uri, text })
    }
    return { files, omitted: input.uris.length - files.length }
  }

  /** Stops every server; open editors are told `restarting` and re-attach, which starts them again. */
  async restartAll(): Promise<string> {
    const entries = [...this.pool.values()]
    for (const doc of this.docs.values()) {
      this.outbox.send(doc.panel, `status:${doc.docId}`, 'phpantom.status', { docId: doc.docId, state: 'restarting' })
    }
    this.docs.clear()
    this.pool.clear()
    this.reveals.clear()
    this.forgetBinary()
    this.resolveError = null
    await Promise.all(entries.map((entry) => this.stopEntry(entry)))
    this.updateStatus()
    const running = entries.filter((entry) => entry.state.phase !== 'error').length
    return running === 0 ? 'PHPantom: nothing was running; servers start again as PHP files open.' : `PHPantom: stopped ${running} server(s); open editors start them again.`
  }

  /** Settings changed: find the binary again before the next server starts. */
  forgetBinary(): void {
    this.resolution = null
    this.resolved = null
  }

  describe(): string {
    const lines: string[] = []
    const resolved = this.resolved
    if (resolved?.ok) {
      lines.push(`PHPantom ${resolved.version} (${SOURCE_WORDS[resolved.source]}): ${resolved.path}`)
    }
    if (this.resolveError) {
      lines.push(`PHPantom error: ${this.resolveError}`)
    }
    for (const entry of this.pool.values()) {
      const { phase, percent, message } = entry.state
      const detail = `${phase}${percent === undefined ? '' : ` ${percent}%`}${message ? ` (${message})` : ''}`
      lines.push(`${entry.root}: ${detail}, ${entry.docs.size} open document(s)`)
      for (const docId of entry.docs) {
        const doc = this.docs.get(docId)
        if (doc) {
          lines.push(`  ${doc.path}: ${doc.diagnostics} diagnostic(s)`)
        }
      }
    }
    return lines.length === 0 ? 'PHPantom: no PHP files open.' : lines.join('\n')
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.statusTimer) {
      clearTimeout(this.statusTimer)
      this.statusTimer = null
    }
    this.outbox.dispose()
    const entries = [...this.pool.values()]
    this.pool.clear()
    this.docs.clear()
    this.chunks.clear()
    await Promise.all(entries.map((entry) => this.stopEntry(entry)))
  }

  private async attach(input: Input<'phpantom.open'>, text: string, panel: string): Promise<AttachStatus> {
    const known = this.docs.get(input.docId)
    if (input.resync && known?.server.alive) {
      known.mirror = new DocumentMirror(text)
      known.version = 1
      known.lspVersion += 1
      known.needsResync = false
      known.panel = panel
      known.server.notify('textDocument/didChange', { textDocument: { uri: known.uri, version: known.lspVersion }, contentChanges: [{ text }] })
      return { state: 'ready', session: this.session, uri: known.uri, capabilities: known.server.capabilities }
    }
    if (known) {
      // Re-attach (perhaps under another workspace): the old server must never post to this docId again.
      this.detach(known)
    }

    const rows = await this.host.listWorkspaces()
    const context = input.branch !== null && input.displayName !== null ? { branch: input.branch, displayName: input.displayName } : undefined
    const focused = resolveFocused(rows, input.workspaceId, context)
    if (focused && !isLocal(focused)) {
      return { state: 'remote', host: focused.hostId ?? 'unknown' }
    }
    const others = rows.filter((row) => row !== focused && isLocal(row)).map((row) => row.path)
    const tiers = [focused ? [focused.path] : [], others].filter((tier) => tier.length > 0)
    const located = await locateFile({ tiers, candidates: this.reveals.paths(), language: input.language, content: text })
    if (located.status === 'none') {
      return { state: 'single-file', reason: 'no-file' }
    }
    if (located.status === 'ambiguous') {
      return { state: 'single-file', reason: 'ambiguous' }
    }
    const path = located.path
    // Why a lookup: a file found through a pending reveal comes back without its workspace.
    const workspace = rows.find((row) => row.path === located.root && isLocal(row)) ?? workspaceFor(path, rows)
    if (!workspace) {
      return { state: 'single-file', reason: 'no-file' }
    }
    const root = composerRoot(path, workspace.path)

    const started = await this.serverFor(root)
    if ('error' in started) {
      return { state: 'error', message: started.error }
    }
    const { entry, server } = started
    const uri = pathToFileURL(path).href
    server.notify('textDocument/didOpen', { textDocument: { uri, languageId: input.language, version: 1, text } })
    this.docs.set(input.docId, {
      docId: input.docId,
      panel,
      uri,
      path,
      root,
      workspace,
      server,
      version: 1,
      lspVersion: 1,
      mirror: new DocumentMirror(text),
      needsResync: false,
      diagnostics: 0
    })
    entry.docs.add(input.docId)
    this.cancelIdle(entry)
    const reveal = this.reveals.take(path)
    return {
      state: 'ready',
      session: this.session,
      uri,
      capabilities: server.capabilities,
      ...(located.approximate ? { approximate: true as const } : {}),
      ...(reveal ? { reveal } : {})
    }
  }

  private attached(docId: string, session: string): Doc | null {
    const doc = this.docs.get(docId)
    return session === this.session && doc && doc.server.alive ? doc : null
  }

  private detach(doc: Doc): void {
    doc.server.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
    this.docs.delete(doc.docId)
    const entry = this.pool.get(doc.root)
    if (entry) {
      entry.docs.delete(doc.docId)
      if (entry.docs.size === 0) {
        this.scheduleIdle(entry)
      }
    }
  }

  private inLane<T>(docId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(docId) ?? Promise.resolve()
    const run = previous.then(task)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.lanes.set(docId, settled)
    void settled.then(() => {
      if (this.lanes.get(docId) === settled) {
        this.lanes.delete(docId)
      }
    })
    return run
  }

  private async serverFor(root: string): Promise<{ entry: Entry; server: PhpantomServer } | { error: string }> {
    let entry = this.pool.get(root)
    if (entry?.server?.alive) {
      return { entry, server: entry.server }
    }
    // Why everything up to `starting` is synchronous: two opens of one root must share one child.
    if (!entry?.starting) {
      if (entry?.crashed) {
        const now = Date.now()
        entry.restarts = entry.restarts.filter((at) => at > now - RESTART_WINDOW_MS)
        if (entry.restarts.length >= MAX_RESTARTS) {
          return { error: `PHPantom stopped ${MAX_RESTARTS + 1} times in 5 minutes for ${root}; run "PHPantom: Restart language servers" to try again. ${entry.state.message ?? ''}`.trim() }
        }
        entry.restarts.push(now)
      }
      if (!entry) {
        entry = { root, server: null, starting: null, state: { phase: 'starting' }, docs: new Set(), restarts: [], crashed: false, idle: null }
        this.pool.set(root, entry)
      }
      const starting = entry
      starting.crashed = false
      starting.starting = this.start(starting).finally(() => {
        starting.starting = null
      })
    }
    try {
      return { entry, server: await entry.starting! }
    } catch (error) {
      return { error: messageOf(error) }
    }
  }

  private async start(entry: Entry): Promise<PhpantomServer> {
    entry.state = { phase: 'starting' }
    this.updateStatus()
    const resolution = await this.binary()
    if (!resolution.ok) {
      this.resolveError = resolution.message
      if (this.pool.get(entry.root) === entry) {
        this.pool.delete(entry.root)
      }
      this.updateStatus()
      throw new Error(resolution.message)
    }
    this.resolveError = null
    if (this.disposed || this.pool.get(entry.root) !== entry) {
      throw new Error('PHPantom was stopped')
    }
    let current: PhpantomServer | null = null
    const server = this.createServer(resolution.path, entry.root, this.eventsFor(entry, () => current))
    current = server
    entry.server = server
    this.host.log(`Starting PHPantom ${resolution.version} for ${entry.root}`)
    try {
      await server.start()
    } catch (error) {
      if (entry.server === server) {
        entry.server = null
        entry.crashed = true
        entry.state = { phase: 'error', message: `PHPantom could not start: ${messageOf(error)}` }
      }
      this.host.log(`PHPantom could not start for ${entry.root}: ${messageOf(error)}`)
      this.updateStatus()
      throw error
    }
    if (this.disposed || this.pool.get(entry.root) !== entry || entry.server !== server) {
      await server.stop().catch(() => undefined)
      throw new Error('PHPantom was stopped')
    }
    this.host.log(`PHPantom ${resolution.version} started for ${entry.root}`)
    this.updateStatus()
    return server
  }

  private eventsFor(entry: Entry, current: () => PhpantomServer | null): ServerEvents {
    // Why a guard: these run inside the server's stdout handler, where a throw would end the worker.
    const guard =
      <A extends unknown[]>(name: string, handler: (...args: A) => void) =>
      (...args: A): void => {
        try {
          if (name === 'log' || (current() !== null && current() === entry.server)) {
            handler(...args)
          }
        } catch (error) {
          this.host.log(`PHPantom ${name} handler failed: ${messageOf(error)}`)
        }
      }
    return {
      diagnostics: guard('diagnostics', (uri: string, diagnostics: unknown[]) => {
        for (const docId of entry.docs) {
          const doc = this.docs.get(docId)
          if (doc && doc.server === entry.server && sameUri(doc.uri, uri)) {
            doc.diagnostics = diagnostics.length
            this.outbox.send(doc.panel, `diag:${docId}`, 'phpantom.diagnostics', { docId, diagnostics, truncated: 0 })
          }
        }
      }),
      progress: guard('progress', (state: ServerState) => {
        entry.state = state
        this.updateStatus()
      }),
      refresh: guard('refresh', (kind: RefreshKind) => {
        const panels = new Set<string>()
        for (const docId of entry.docs) {
          const doc = this.docs.get(docId)
          if (doc) {
            panels.add(doc.panel)
          }
        }
        for (const panel of panels) {
          const key = `refresh:${panel}`
          const queued = this.outbox.queued(key) as { kinds: RefreshKind[] } | undefined
          const kinds = new Set(queued?.kinds ?? [])
          kinds.add(kind)
          this.outbox.send(panel, key, 'phpantom.refresh', { kinds: [...kinds] })
        }
      }),
      log: guard('log', (message: string) => this.host.log(`PHPantom (${entry.root}): ${message}`)),
      exit: guard('exit', (reason: string) => {
        const message = `PHPantom stopped: ${reason}`
        entry.server = null
        entry.crashed = true
        entry.state = { phase: 'error', message }
        this.cancelIdle(entry)
        for (const docId of entry.docs) {
          const doc = this.docs.get(docId)
          if (doc) {
            this.outbox.send(doc.panel, `status:${docId}`, 'phpantom.status', { docId, state: 'error', message })
            this.docs.delete(docId)
          }
        }
        entry.docs.clear()
        this.host.log(`${message} (${entry.root})`)
        this.updateStatus()
      })
    }
  }

  private scheduleIdle(entry: Entry): void {
    if (entry.idle) {
      return
    }
    entry.idle = setTimeout(() => {
      entry.idle = null
      if (entry.docs.size > 0 || this.pool.get(entry.root) !== entry || entry.starting) {
        return
      }
      this.pool.delete(entry.root)
      this.host.log(`Stopping the idle PHPantom for ${entry.root}`)
      void this.stopEntry(entry).then(() => this.updateStatus())
    }, this.idleMs)
    entry.idle.unref?.()
  }

  private cancelIdle(entry: Entry): void {
    if (entry.idle) {
      clearTimeout(entry.idle)
      entry.idle = null
    }
  }

  private async stopEntry(entry: Entry): Promise<void> {
    this.cancelIdle(entry)
    const server = entry.server
    entry.server = null
    try {
      await server?.stop()
    } catch (error) {
      this.host.log(`PHPantom did not stop cleanly for ${entry.root}: ${messageOf(error)}`)
    }
  }

  private binary(): Promise<Resolution> {
    if (!this.resolution) {
      const pending = this.findBinary()
      this.resolution = pending
      void pending.then((resolution) => {
        if (this.resolution !== pending) {
          return
        }
        if (resolution.ok) {
          this.resolved = resolution
          this.host.log(`Using PHPantom ${resolution.version} (${SOURCE_WORDS[resolution.source]}): ${resolution.path}`)
        } else {
          // Why not cached: the next open tries again (a download may work then).
          this.resolution = null
          this.host.log(`PHPantom is not available: ${resolution.message}`)
        }
      })
    }
    return this.resolution
  }

  private async findBinary(): Promise<Resolution> {
    try {
      const settings = await this.host.settings()
      return await this.resolve({
        settingPath: settings.phpantomPath,
        allowDownload: settings.allowDownload,
        env: process.env,
        platform: process.platform,
        arch: process.arch,
        home: homedir(),
        onDownload: () => {
          this.downloading = true
          this.updateStatus()
        }
      })
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    } finally {
      if (this.downloading) {
        this.downloading = false
        this.updateStatus()
      }
    }
  }

  private fitAnswer(method: string, result: unknown): Output<'phpantom.request'> {
    if (bytes(result) <= MAX_ANSWER_BYTES) {
      return { result }
    }
    const items = Array.isArray(result) ? result : (result as { items?: unknown } | null)?.items
    if (method !== 'textDocument/completion' || !Array.isArray(items)) {
      return { error: 'too_large' }
    }
    const shell = Array.isArray(result) ? {} : (result as Record<string, unknown>)
    let room = MAX_ANSWER_BYTES - bytes({ result: { ...shell, isIncomplete: true, items: [] } })
    const kept: unknown[] = []
    for (const item of items) {
      const size = bytes(item) + (kept.length > 0 ? 1 : 0)
      if (size > room) {
        break
      }
      room -= size
      kept.push(item)
    }
    return { result: { ...shell, isIncomplete: true, items: kept } }
  }

  /** At most once a second; a change inside the second is sent when it ends, so the last state arrives. */
  private updateStatus(): void {
    if (this.disposed || this.statusTimer) {
      return
    }
    const wait = this.lastStatusAt + STATUS_INTERVAL_MS - Date.now()
    if (wait <= 0) {
      this.emitStatus()
      return
    }
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.emitStatus()
    }, wait)
    this.statusTimer.unref?.()
  }

  private emitStatus(): void {
    if (this.disposed) {
      return
    }
    const states: ServerState[] = [...this.pool.values()].map((entry) => entry.state)
    if (this.downloading) {
      states.push({ phase: 'downloading' })
    }
    if (this.resolveError) {
      states.push({ phase: 'error', message: this.resolveError })
    }
    const state = aggregate(states)
    if (state.phase === 'ready' && this.resolved?.ok) {
      state.version = this.resolved.version
      state.source = this.resolved.source
    }
    const update = renderStatus(state)
    const key = JSON.stringify(update)
    if (key === this.lastStatus) {
      return
    }
    this.lastStatusAt = Date.now()
    this.lastStatus = key
    try {
      this.host.status(update)
    } catch (error) {
      this.host.log(`status bar update failed: ${messageOf(error)}`)
    }
  }
}
