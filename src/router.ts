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
import { sameUri, uriKey } from './lsp/uri.ts'
import { Outbox } from './outbox.ts'
import type { AttachStatus } from './protocol.ts'
import { PendingReveals } from './reveals.ts'
import { fitsIn, leadingThatFit, orcaSize } from './size.ts'
import { aggregate, renderStatus, type ServerState, type StatusBarUpdate } from './status.ts'

export type RouterHost = {
  /** May answer from a short cache; `fresh` asks Orca again. */
  listWorkspaces(options?: { fresh?: boolean }): Promise<WorkspaceRow[]>
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
  /** A document not heard from (open, change, request, navigate, peek, ping) for this long is released. */
  leaseMs?: number
  /** How often to look for such documents. */
  sweepMs?: number
  sessionId?: string
  /** The clock for leases and the binary-failure cache; tests drive it. */
  now?: () => number
}

type Input<K extends keyof PluginRequests> = PluginRequests[K]['input']
type Output<K extends keyof PluginRequests> = PluginRequests[K]['output']

type Entry = {
  root: string
  server: PhpantomServer | null
  starting: Promise<PhpantomServer> | null
  state: ServerState
  docs: Set<string>
  /** Open files by `uriKey`: two documents of one file share a single didOpen. */
  files: Map<string, SharedFile>
  /** When this root was restarted after a crash, for the 3-in-5-minutes budget. */
  restarts: number[]
  crashed: boolean
  idle: ReturnType<typeof setTimeout> | null
}

/** One file as PHPantom knows it, and the documents attached to it. */
type SharedFile = {
  uri: string
  holders: Set<string>
  /** The text PHPantom holds now. Each holder's edits are computed against its own copy, so they are
   *  forwarded only when that copy is this text. */
  text: string
  /** What PHPantom is told; it only rises, so a resync never sends PHPantom an older version. */
  version: number
  /** What PHPantom last published for it: a document joining with the same text gets nothing newer. */
  diagnostics: unknown[] | null
}

type Doc = {
  docId: string
  panel: string
  uri: string
  path: string
  root: string
  workspace: WorkspaceRow
  entry: Entry
  server: PhpantomServer
  file: SharedFile
  /** The editor's version, which restarts at 1 on a resync. */
  version: number
  mirror: DocumentMirror
  needsResync: boolean
  diagnostics: number
  /** When its editor was last heard from; see `leaseMs`. */
  lastSeen: number
}

// Orca takes an answer of at most 1 MiB and 10,000 objects by its own measure (see size.ts); this
// leaves room for what the measure may miss.
const ANSWER_LIMIT = { bytes: 900 * 1024, objects: 9000 }
// Lists whose leading items are still a useful answer. Never edits: half a formatting is a broken file.
const CUTTABLE_LISTS = new Set([
  'textDocument/references',
  'textDocument/definition',
  'textDocument/declaration',
  'textDocument/typeDefinition',
  'textDocument/implementation',
  'textDocument/documentHighlight',
  'textDocument/documentSymbol',
  'textDocument/inlayHint',
  'textDocument/codeAction'
])
const PEEK_MAX_FILES = 25
// Files attached before, tried again when a tab of theirs is shown: a new frame must locate its file anew,
// and the walk never reaches Composer's vendor folder, where go to definition often leads.
const REMEMBERED_FILES = 50
const PEEK_MAX_BYTES = 600 * 1024
const IDLE_MS = 10 * 60_000
// Why a lease: an editor frame that remounts (Orca does on every tab show) or dies never sends its close.
// The editor pings every 20 s; three minutes is nine missed pings, room for a busy or throttled frame.
const LEASE_MS = 3 * 60_000
const SWEEP_MS = 15_000
// A failed lookup or download is kept this long, so tabs retrying (on show, after typing) do not download in a loop.
const FAILED_BINARY_MS = 2 * 60_000
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
  private readonly leaseMs: number
  private readonly now: () => number
  private readonly sweepMs: number
  private readonly sweepTimer: ReturnType<typeof setInterval>
  private lastSweepAt: number
  private readonly outbox: Outbox
  private readonly reveals = new PendingReveals()
  /** Paths attached since the worker started, oldest first; see REMEMBERED_FILES. */
  private readonly remembered = new Set<string>()
  private readonly pool = new Map<string, Entry>()
  private readonly docs = new Map<string, Doc>()
  private readonly chunks = new Map<string, string[]>()
  private readonly lanes = new Map<string, Promise<void>>()
  private resolution: Promise<Resolution> | null = null
  /** When `resolution` failed; it is looked up again FAILED_BINARY_MS later. */
  private failedAt: number | null = null
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
    this.leaseMs = options.leaseMs ?? LEASE_MS
    this.now = options.now ?? Date.now
    this.session = options.sessionId ?? randomUUID()
    this.outbox = new Outbox((event, payload, postOptions) => host.post(event, payload, postOptions))
    this.sweepMs = options.sweepMs ?? SWEEP_MS
    this.lastSweepAt = this.now()
    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepMs)
    this.sweepTimer.unref?.()
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
    this.seen(input.docId)
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
    const before = doc.mirror.text
    doc.mirror.apply(input.changes)
    if (doc.mirror.length !== input.length) {
      doc.needsResync = true
      return { resync: true }
    }
    doc.version = input.version
    const file = doc.file
    const after = doc.mirror.text
    // Why no compare for a lone holder: nobody else moves PHPantom's copy, so it is this document's text.
    // With several, `===` on the same string is a pointer check; lengths that differ fail at once.
    if (file.holders.size === 1 || before === file.text) {
      this.sendChange(doc.server, file, input.changes, after)
    } else if (after !== file.text) {
      // PHPantom holds another tab's text: this edit would land on the wrong text, so send the whole of it.
      this.sendFull(doc.server, file, after)
    }
    // Otherwise the other tab already sent this same result.
    return { ok: true }
  }

  async request(input: Input<'phpantom.request'>, signal: AbortSignal): Promise<Output<'phpantom.request'>> {
    const doc = this.attached(input.docId, input.session)
    if (!doc) {
      return { detached: true }
    }
    if (doc.needsResync) {
      // Its copy failed the length check: an answer now would be about text the editor does not have.
      return { error: 'the document is being sent again' }
    }
    // Why: several documents can hold one file, and PHPantom holds whichever sent last. Positions in the
    // question, and edits in the answer, are this document's.
    this.sendFull(doc.server, doc.file, doc.mirror.text)
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

  async ping(input: Input<'phpantom.ping'>): Promise<Output<'phpantom.ping'>> {
    return this.attached(input.docId, input.session) ? { ok: true } : { detached: true }
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
    for (const doc of [...this.docs.values()]) {
      this.forget(doc.docId)
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
    this.failedAt = null
    this.resolved = null
    // Why clear the error: it described the old settings; the next open finds out about the new ones.
    if (this.resolveError) {
      this.resolveError = null
      this.updateStatus()
    }
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
    clearInterval(this.sweepTimer)
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
      known.needsResync = false
      known.panel = panel
      known.lastSeen = this.now()
      this.sendFull(known.server, known.file, text)
      return { state: 'ready', session: this.session, uri: known.uri, capabilities: known.server.capabilities }
    }
    if (known) {
      // Re-attach (perhaps under another workspace): the old server must never post to this docId again.
      this.detach(known)
    }

    let rows = await this.host.listWorkspaces()
    if (input.workspaceId !== null && !rows.some((row) => row.id === input.workspaceId)) {
      // Why ask again: a worktree made in the last few seconds is missing from the cached list, and
      // without its row the file would attach to a sibling's copy (or a remote one to a local look-alike).
      rows = await this.host.listWorkspaces({ fresh: true })
    }
    const context = input.branch !== null && input.displayName !== null ? { branch: input.branch, displayName: input.displayName } : undefined
    const focused = resolveFocused(rows, input.workspaceId, context)
    if (focused && !isLocal(focused)) {
      return { state: 'remote', host: focused.hostId ?? 'unknown' }
    }
    const others = rows.filter((row) => row !== focused && isLocal(row)).map((row) => row.path)
    const tiers = [focused ? [focused.path] : [], others].filter((tier) => tier.length > 0)
    const remembered = new Set([...this.remembered, ...[...this.docs.values()].map((doc) => doc.path)])
    const located = await locateFile({ tiers, candidates: this.reveals.paths(), known: [...remembered], language: input.language, content: text })
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
    this.remember(path)

    const started = await this.serverFor(root)
    if ('error' in started) {
      return { state: 'error', message: started.error }
    }
    const { entry, server } = started
    const uri = pathToFileURL(path).href
    const key = uriKey(uri)
    let file = entry.files.get(key)
    if (file) {
      // Another document already holds this file: PHPantom gets this one's text, not a second didOpen.
      this.sendFull(server, file, text)
    } else {
      file = { uri, holders: new Set(), text, version: 1, diagnostics: null }
      entry.files.set(key, file)
      server.notify('textDocument/didOpen', { textDocument: { uri, languageId: input.language, version: 1, text } })
    }
    file.holders.add(input.docId)
    this.docs.set(input.docId, {
      docId: input.docId,
      panel,
      uri,
      path,
      root,
      workspace,
      entry,
      server,
      file,
      version: 1,
      mirror: new DocumentMirror(text),
      needsResync: false,
      diagnostics: file.diagnostics?.length ?? 0,
      lastSeen: this.now()
    })
    entry.docs.add(input.docId)
    this.cancelIdle(entry)
    if (file.diagnostics) {
      this.outbox.send(panel, `diag:${input.docId}`, 'phpantom.diagnostics', { docId: input.docId, diagnostics: file.diagnostics, truncated: 0 })
    }
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

  private remember(path: string): void {
    this.remembered.delete(path)
    this.remembered.add(path)
    for (const oldest of this.remembered) {
      if (this.remembered.size <= REMEMBERED_FILES) {
        break
      }
      this.remembered.delete(oldest)
    }
  }

  /** The document when `session` is current and its server alive; finding it renews its lease. */
  private attached(docId: string, session: string): Doc | null {
    const doc = this.docs.get(docId)
    if (session !== this.session || !doc || !doc.server.alive) {
      return null
    }
    doc.lastSeen = this.now()
    return doc
  }

  private seen(docId: string): void {
    const doc = this.docs.get(docId)
    if (doc) {
      doc.lastSeen = this.now()
    }
  }

  /** Releases documents whose editor went quiet, as `close` would. The timer calls it; resolves once they are released. */
  async sweep(): Promise<void> {
    if (this.disposed) {
      return
    }
    const now = this.now()
    const gap = now - this.lastSweepAt
    this.lastSweepAt = now
    if (gap > 2 * this.sweepMs) {
      // The computer slept or the worker was held up: editors could not ping meanwhile either, so silence
      // says nothing yet. The next tick, on time, judges after they have had the chance.
      this.host.log(`Lease check ran ${Math.round((gap - this.sweepMs) / 1000)} s late; releasing nothing this time`)
      return
    }
    const expired = (doc: Doc | undefined): doc is Doc => doc !== undefined && this.now() - doc.lastSeen > this.leaseMs
    const releases: Promise<void>[] = []
    for (const doc of this.docs.values()) {
      if (!expired(doc)) {
        continue
      }
      const docId = doc.docId
      // Why in its lane and checked again there: an open in flight for this docId finishes first, and a
      // document it attached anew has just been seen.
      releases.push(
        this.inLane(docId, async () => {
          const current = this.docs.get(docId)
          if (this.disposed || current !== doc || !expired(current)) {
            return
          }
          this.host.log(`Released ${current.path}: its editor was not heard from for ${Math.round(this.leaseMs / 1000)} s (${this.docs.size - 1} document(s) still open)`)
          this.chunks.delete(docId)
          this.detach(current)
        }).catch((error: unknown) => this.host.log(`releasing ${docId} failed: ${messageOf(error)}`))
      )
    }
    await Promise.all(releases)
  }

  private detach(doc: Doc): void {
    const { entry, file } = doc
    file.holders.delete(doc.docId)
    const remaining = [...file.holders].map((docId) => this.docs.get(docId)).filter((other) => other !== undefined)
    if (remaining.length > 0) {
      // Why resend: PHPantom holds whatever the leaving document sent last. The one heard from most recently is
      // the tab on screen; the others are frames Orca replaced that hold on until their lease ends. One waiting
      // for its resync has a copy that is not its editor's text, and sends the whole text soon anyway.
      const current = remaining.filter((other) => !other.needsResync).sort((a, b) => b.lastSeen - a.lastSeen)[0]
      if (current) {
        this.sendFull(doc.server, file, current.mirror.text)
      }
    } else {
      entry.files.delete(uriKey(file.uri))
      doc.server.notify('textDocument/didClose', { textDocument: { uri: file.uri } })
    }
    this.forget(doc.docId)
    entry.docs.delete(doc.docId)
    if (entry.docs.size === 0 && this.pool.get(entry.root) === entry) {
      this.scheduleIdle(entry)
    }
  }

  /** Drops a document and anything still queued for it, so an old attachment never posts to it. */
  private forget(docId: string): void {
    this.docs.delete(docId)
    this.outbox.drop(`diag:${docId}`)
  }

  /** Forwards an edit made against `file.text`; `after` is the text it gives. */
  private sendChange(server: PhpantomServer, file: SharedFile, contentChanges: unknown[], after: string): void {
    file.text = after
    file.version += 1
    server.notify('textDocument/didChange', { textDocument: { uri: file.uri, version: file.version }, contentChanges })
  }

  /** Sets PHPantom's copy to `text`, unless it already is. */
  private sendFull(server: PhpantomServer, file: SharedFile, text: string): void {
    if (text === file.text) {
      return
    }
    this.sendChange(server, file, [{ text }], text)
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
        entry = { root, server: null, starting: null, state: { phase: 'starting' }, docs: new Set(), files: new Map(), restarts: [], crashed: false, idle: null }
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
    entry.files.clear()
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
        const file = entry.files.get(uriKey(uri))
        if (file) {
          file.diagnostics = diagnostics
        }
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
            this.forget(docId)
            this.outbox.send(doc.panel, `status:${docId}`, 'phpantom.status', { docId, state: 'error', message })
          }
        }
        entry.docs.clear()
        entry.files.clear()
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
    if (this.resolution && this.failedAt !== null && this.now() - this.failedAt >= FAILED_BINARY_MS) {
      // Why look again at all: a download may work now, or the binary may have been installed meanwhile.
      this.resolution = null
      this.failedAt = null
    }
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
          this.failedAt = this.now()
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

  /** The answer as Orca will take it: a list cut to its leading items when it would be refused whole. */
  private fitAnswer(method: string, result: unknown): Output<'phpantom.request'> {
    if (fitsIn(orcaSize({ result }), ANSWER_LIMIT)) {
      return { result }
    }
    if (method === 'textDocument/completion') {
      const items = Array.isArray(result) ? result : (result as { items?: unknown } | null)?.items
      if (Array.isArray(items)) {
        const shell = Array.isArray(result) ? {} : (result as Record<string, unknown>)
        const kept = leadingThatFit(items, orcaSize({ result: { ...shell, isIncomplete: true, items: [] } }), ANSWER_LIMIT)
        return { result: { ...shell, isIncomplete: true, items: kept } }
      }
    }
    if (CUTTABLE_LISTS.has(method) && Array.isArray(result)) {
      // Why measure with the full count: a number is 8 bytes to Orca whatever its value.
      const kept = leadingThatFit(result, orcaSize({ result: [], truncated: result.length }), ANSWER_LIMIT)
      return { result: kept, truncated: result.length - kept.length }
    }
    const tokens = method === 'textDocument/semanticTokens/full' ? (result as { data?: unknown } | null)?.data : undefined
    if (Array.isArray(tokens)) {
      // Why whole tokens: `data` is five numbers per token, each relative to the one before, so a leading
      // run of whole tokens is still correct colouring; a number is 8 bytes plus 4 for its slot in the array.
      const shell = orcaSize({ result: { ...(result as object), data: [] } })
      const room = Math.floor((ANSWER_LIMIT.bytes - shell.bytes) / 12)
      const count = Math.max(0, Math.min(tokens.length, room) - (Math.min(tokens.length, room) % 5))
      return { result: { ...(result as object), data: tokens.slice(0, count) } }
    }
    return { error: 'too_large' }
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
