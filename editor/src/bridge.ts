// Keeps one editor's document attached to PHPantom through the worker: opens it in chunks, streams
// Incremental changes, forwards LSP requests, and opens it again when the worker or its server restarts
// Or the frame turns out to belong to another workspace. No Monaco here, so Node can test it with fakes.
import type { PluginRequestInput, PluginRequestOutput, PluginRequests } from 'orca';

import type { AttachStatus, Language, LspContentChange, LspRange } from '../../src/protocol.ts';
import { isRateLimited, Pacer } from './pacer.ts';
import { chunkText, splitChanges } from './split.ts';

type Disposable = { dispose(): void };
type Ready = AttachStatus & { state: 'ready' };

export type WorkspaceContext = { workspaceId: string | null; branch: string; displayName: string };

export type BridgeHost = {
  request<K extends keyof PluginRequests>(
    name: K,
    input: PluginRequestInput<K>,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<PluginRequestOutput<K>>;
  /** What the worker posts to this editor's panel; every frame of the editor hears every post. */
  on(event: string, handler: (payload: any) => void): Disposable;
  /** The focused workspace, which is not always this frame's: see the R2 notes on LspBridge. */
  readContext(): Promise<WorkspaceContext | null>;
  /** Orca's `workspace.changed`, the current context first. Background frames hear it too. */
  onWorkspaceChanged(listener: (context: WorkspaceContext | null) => void): Disposable;
  /** The first pointer or key press inside this frame; only the frame on screen can get one. */
  onFirstInput(listener: () => void): Disposable;
  /** The tab was shown. Only a moment to retry a failed attach, never a reason to re-attach. */
  onVisible(listener: () => void): Disposable;
  /** Orca is about to save the file. The listener must not delay the save. */
  onSaved(listener: () => void): Disposable;
  /** The plugin's settings changed (say, the PHPantom path), which can fix a failed attach. */
  onSettingsChanged(listener: () => void): Disposable;
};

/** A content change with the length of the text it replaced, as Monaco reports it. */
export type SourceChange = { range: LspRange; rangeLength: number; text: string };

export type DocumentSource = {
  language: Language;
  getText(): string;
  getLength(): number;
  /** Rises with every change. */
  getVersion(): number;
  /** `isFlush`: the whole text was replaced (or its line endings changed), so send it whole. */
  onChanges(listener: (changes: SourceChange[], isFlush: boolean) => void): Disposable;
};

/**
 * How a request is paced. `user`: someone asked (go to definition, rename, format, an invoked fix); it
 * waits out a short hold and is retried once, then says the editor is busy. `passive`: Monaco asked on
 * its own (hover, completion as you type); dropped while Orca holds calls back or past this editor's
 * share. `background`: whole-document answers Monaco asks again after every change (colouring, inlay
 * hints, the outline, the lightbulb); as passive, and it first waits for a pause in typing.
 */
export type RequestKind = 'user' | 'passive' | 'background';

/** `silent`: a user request Monaco also makes on its own (resolving a focused item); it never shows the busy note. */
export type AskOptions = { timeoutMs?: number; kind?: RequestKind; silent?: boolean };

export type BridgeOptions = {
  docId?: string;
  /** Most time a typed change waits before it is sent; changes typed meanwhile go with it in one request. */
  syncDelayMs?: number;
  /** Least time between two attempts to attach a file the worker could not place. */
  retryGapMs?: number;
  maxRetries?: number;
  /** Time without typing before such a retry. */
  quietMs?: number;
  /** Wait after a save or a settings change before a retry, so the save lands first. */
  saveDelayMs?: number;
  /** Least time between two re-attaches after the worker lost the document. */
  reattachGapMs?: number;
  /** After mounting, a `workspace.changed` this soon names the frame's real workspace (R2). */
  mountWindowMs?: number;
  /** How long after a workspace switch `readContext` may still answer the previous workspace (R2). */
  settleMs?: number;
  /** Time between two pings that renew the worker's lease on this document while attached. */
  pingMs?: number;
  /** Most passive and background requests in 10 s; Orca's 120 is shared by every PHPantom tab. */
  passiveCap?: number;
  /** The hold after Orca refuses a call for the rate limit without saying how long, doubling up to the most. */
  firstBackoffMs?: number;
  maxBackoffMs?: number;
  /** Time without typing a background request waits for. */
  backgroundQuietMs?: number;
  /** The least a background request waits, so one Monaco replaces (a scroll, a cursor move) is cancelled unsent. */
  backgroundMinWaitMs?: number;
  /** The longest hold a user request waits out before it says the editor is busy instead. */
  userMaxWaitMs?: number;
};

// Requests whose answer edits the text: applied to a text that moved since, they would corrupt it.
const VERSION_GUARDED = new Set([
  'textDocument/formatting',
  'textDocument/rangeFormatting',
  'textDocument/rename',
  'codeAction/resolve',
]);
// The last chunk waits for PHPantom to start, which can mean a cold index or a download.
const LAST_CHUNK_TIMEOUT_MS = 120_000;

type Events = {
  ready: Ready;
  status: AttachStatus;
  diagnostics: unknown[];
  refresh: string[];
  reveal: LspRange;
  busy: undefined;
};
type QueuedEvent = { changes: SourceChange[]; lengthAfter: number };
type Group = { changes: LspContentChange[]; length: number };

const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const isEmpty = (range: LspRange): boolean =>
  range.start.line === range.end.line && range.start.character === range.end.character;

/** Resolves after `ms`, or as soon as `signal` aborts. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * An event's changes as request-sized groups, each with the document length after it, and the length
 * before the event. Pieces of a split change stay in order in consecutive groups; the first piece keeps
 * the change's own range object and the rest are inserts, which is how each group's length is worked
 * back from the event's final length. Null when a length cannot be worked out: the caller resyncs.
 */
function groupsOf(event: QueuedEvent): { groups: Group[]; lengthBefore: number } | null {
  const replaced = new Map<LspRange, number>();
  for (const change of event.changes) {
    replaced.set(change.range, change.rangeLength);
  }
  const groups = splitChanges(
    event.changes.map((change): LspContentChange => ({ range: change.range, text: change.text }))
  );
  const out: Group[] = [];
  let length = event.lengthAfter;
  for (let i = groups.length - 1; i >= 0; i--) {
    out[i] = { changes: groups[i], length };
    for (const change of groups[i]) {
      if (!('range' in change)) {
        return null;
      }
      const removed = replaced.get(change.range) ?? (isEmpty(change.range) ? 0 : Number.NaN);
      length -= change.text.length - removed;
    }
  }
  return Number.isNaN(length) ? null : { groups: out, lengthBefore: length };
}

/**
 * Workspace (ruling R2): `readContext` names the focused workspace, which at mount or just after a switch
 * can still be the previous one, and frames of every worktree hear `visibilitychange` and
 * `workspace.changed`. So the first attach is provisional; it moves once if `workspace.changed` names
 * another workspace within `mountWindowMs` of mounting, and once if the context read after the first
 * input in this frame (and `settleMs` after the last switch) differs. Nothing else re-targets it.
 */
export class LspBridge {
  readonly docId: string;
  private readonly host: BridgeHost;
  private readonly source: DocumentSource;
  private readonly syncDelayMs: number;
  private readonly retryGapMs: number;
  private readonly maxRetries: number;
  private readonly quietMs: number;
  private readonly saveDelayMs: number;
  private readonly reattachGapMs: number;
  private readonly mountWindowMs: number;
  private readonly settleMs: number;
  private readonly pingMs: number;
  private readonly backgroundQuietMs: number;
  private readonly backgroundMinWaitMs: number;
  private readonly userMaxWaitMs: number;
  private readonly pacer: Pacer;
  private readonly subscriptions: Disposable[] = [];
  private readonly listeners: { [K in keyof Events]: Set<(value: Events[K]) => void> } = {
    ready: new Set(),
    status: new Set(),
    diagnostics: new Set(),
    refresh: new Set(),
    reveal: new Set(),
    busy: new Set(),
  };

  private current: AttachStatus | null = null;
  private attachedTo: Ready | null = null;
  private version = 1;
  /** The length the worker holds after the last change sent. */
  private sentLength = 0;
  /** Changes since the last snapshot are queued only while an attach is in flight or done. */
  private accepting = false;
  private queue: QueuedEvent[] = [];
  /** Groups of changes Orca refused for the rate limit; they go out first, as they were. */
  private unsent: Group[] = [];
  private lastChangeAt = 0;
  /** Set when a background request was dropped during a hold: Monaco would not ask again until the next edit. */
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private needsResync = false;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  /** Opens and changes run one at a time, so two chunk sequences for this document never interleave. */
  private lane: Promise<unknown> = Promise.resolve();
  /** Rises with each open; an open or change from an older one stops and its answer is dropped. */
  private generation = 0;
  private latest: Promise<AttachStatus | null> | null = null;
  private disposed = false;

  private context: WorkspaceContext | null = null;
  private contextFromEvent = false;
  /** The workspace the latest open was started with; undefined before the first. */
  private targetWorkspace: string | null | undefined = undefined;
  private readonly mountedAt = Date.now();
  private lastSwitchAt = 0;
  private mountMoved = false;
  private confirmed = false;

  /** Attempts spent since the last success, save or settings change. */
  private retries = 0;
  /** The last attempt failed in a way a later one can fix: single-file, error, or no answer. */
  private retryable = false;
  private retryEarliest = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Chunk sequences cut short (the worker restarted between chunks) since the last success. */
  private broken = 0;
  private reattaching: Promise<boolean> | null = null;
  private reattachTimer: ReturnType<typeof setTimeout> | undefined;
  private lastReattachAt = Number.NEGATIVE_INFINITY;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  /** The ping in flight, if any: one at a time, and one from before a re-attach does not hold up the next. */
  private pinging: object | null = null;

  constructor(host: BridgeHost, source: DocumentSource, options: BridgeOptions = {}) {
    this.host = host;
    this.source = source;
    this.docId = options.docId ?? crypto.randomUUID();
    this.syncDelayMs = options.syncDelayMs ?? 400;
    this.retryGapMs = options.retryGapMs ?? 8000;
    this.maxRetries = options.maxRetries ?? 20;
    this.quietMs = options.quietMs ?? 2000;
    this.saveDelayMs = options.saveDelayMs ?? 1000;
    this.reattachGapMs = options.reattachGapMs ?? 5000;
    this.mountWindowMs = options.mountWindowMs ?? 1500;
    this.settleMs = options.settleMs ?? 1500;
    this.pingMs = options.pingMs ?? 20_000;
    this.backgroundQuietMs = options.backgroundQuietMs ?? 500;
    this.backgroundMinWaitMs = options.backgroundMinWaitMs ?? 250;
    this.userMaxWaitMs = options.userMaxWaitMs ?? 3000;
    this.pacer = new Pacer({
      passiveCap: options.passiveCap,
      firstBackoffMs: options.firstBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
    });

    // Listen before the first open: PHPantom publishes diagnostics while the open is still answering.
    const mine = (payload: { docId?: unknown } | null | undefined): boolean =>
      payload?.docId === this.docId;
    this.subscriptions.push(
      host.on('phpantom.diagnostics', (payload) => {
        if (mine(payload) && Array.isArray(payload.diagnostics)) {
          this.emit('diagnostics', payload.diagnostics);
        }
      }),
      host.on('phpantom.reveal', (payload) => {
        if (mine(payload)) this.emit('reveal', payload.range);
      }),
      host.on('phpantom.refresh', (payload) => {
        if (Array.isArray(payload?.kinds)) this.emit('refresh', payload.kinds);
      }),
      host.on('phpantom.status', (payload) => {
        // The worker dropped this document (restart, or its server crashed): open it again.
        if (
          mine(payload) &&
          this.attachedTo &&
          (payload.state === 'restarting' || payload.state === 'error')
        ) {
          this.lost();
        }
      }),
      host.onWorkspaceChanged((context) => {
        this.workspaceChanged(context);
      }),
      host.onVisible(() => {
        this.lastSwitchAt = Date.now();
        this.retrySoon(this.quietMs, false);
      }),
      // A save is what makes a new file findable; a settings change can fix a missing binary.
      host.onSaved(() => {
        this.retrySoon(this.saveDelayMs, true);
      }),
      host.onSettingsChanged(() => {
        this.retrySoon(this.saveDelayMs, true);
      }),
      source.onChanges((changes, isFlush) => {
        this.changed(changes, isFlush);
      })
    );
    const firstInput = host.onFirstInput(() => {
      firstInput.dispose();
      void this.confirmWorkspace();
    });
    this.subscriptions.push(firstInput);
  }

  get status(): AttachStatus | null {
    return this.current;
  }

  /** Attaches the document; resolves with the answer of the latest attempt (a re-target may replace this one). */
  async attach(): Promise<AttachStatus> {
    if (this.targetWorkspace === undefined && !this.contextFromEvent) {
      const read = await this.host.readContext().catch(() => null);
      // Why the check: a workspace.changed that arrived meanwhile is at least as new.
      if (!this.contextFromEvent) this.context = read;
    }
    return this.settled(this.start(false));
  }

  /** Sends `method` once queued changes are in; null when aborted, failed, held back, or (for edits) outdated. */
  async ask(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    options: AskOptions = {}
  ): Promise<unknown | null> {
    return (await this.askDetailed(method, params, signal, options))?.result ?? null;
  }

  /** As `ask`, with how many items the worker cut from a list too large for Orca to carry. */
  async askDetailed(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    options: AskOptions = {}
  ): Promise<{ result: unknown; truncated: number } | null> {
    const kind = options.kind ?? 'user';
    const busy = (): void => {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- emit() takes the payload as a required argument
      if (!options.silent) this.emit('busy', undefined);
    };
    const requestOptions =
      signal || options.timeoutMs
        ? {
            ...(signal ? { signal } : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          }
        : undefined;
    // Why: Monaco shifts a background answer by every edit made after it asked; one that holds them already would move twice.
    const askedAt = this.source.getVersion();
    if (kind === 'background' && !(await this.typingPaused(askedAt, signal))) return null;
    let reattached = false;
    let refused = false;
    for (;;) {
      if (signal?.aborted || !this.attachedTo) return null;
      if (
        kind === 'user'
          ? !(await this.holdPassed(signal, options.silent))
          : !this.pacer.takePassive()
      ) {
        if (kind === 'background') this.refreshLater();
        return null;
      }
      await this.flush(true);
      const attachment = this.attachedTo;
      const session = attachment?.session;
      if (!attachment || !session || signal?.aborted) return null;
      // Why: changes Orca refused are not in the worker's copy yet, so an answer would be about older text.
      if (this.unsent.length > 0) {
        if (kind === 'user') busy();
        if (kind === 'background') this.refreshLater();
        return null;
      }
      const version = this.source.getVersion();
      if (kind === 'background' && version !== askedAt) return null;
      let answer: PluginRequestOutput<'phpantom.request'>;
      try {
        answer = await this.send(
          'phpantom.request',
          { docId: this.docId, session, method, params },
          requestOptions
        );
      } catch (error) {
        if (signal?.aborted) return null;
        if (isRateLimited(error)) {
          if (kind === 'background') this.refreshLater();
          if (kind !== 'user') return null;
          if (refused) {
            busy();
            return null;
          }
          refused = true;
          continue;
        }
        if (codeOf(error) !== 'unavailable') return null;
        answer = { detached: true };
      }
      if (signal?.aborted) return null;
      if ('detached' in answer) {
        if (reattached) return null;
        reattached = true;
        if (this.attachedTo?.session === session) {
          this.lost();
        }
        if (!(await this.reattachNow())) return null;
        continue;
      }
      if ('error' in answer) return null;
      // Why: the session outlives a re-target to another worktree; that answer is about the other copy.
      if (this.attachedTo?.session !== session || this.attachedTo.uri !== attachment.uri) {
        return null;
      }
      if (VERSION_GUARDED.has(method) && this.source.getVersion() !== version) return null;
      return { result: answer.result ?? null, truncated: answer.truncated ?? 0 };
    }
  }

  /** Opens `uri` in an Orca tab, revealing `range` there; null when not attached or the worker failed. */
  async navigate(
    uri: string,
    range: LspRange
  ): Promise<PluginRequestOutput<'phpantom.navigate'> | null> {
    const session = this.attachedTo?.session;
    if (!session) return null;
    return this.userCall(async () =>
      this.send('phpantom.navigate', { docId: this.docId, session, uri, range })
    );
  }

  /** The text of files on disk, for Monaco's previews; null when not attached, aborted or failed. */
  async peek(
    uris: string[],
    signal?: AbortSignal
  ): Promise<PluginRequestOutput<'phpantom.peek'> | null> {
    const session = this.attachedTo?.session;
    if (!session || signal?.aborted) return null;
    return this.userCall(
      async () =>
        this.send(
          'phpantom.peek',
          { docId: this.docId, session, uris },
          signal ? { signal } : undefined
        ),
      signal
    );
  }

  onReady(listener: (status: Ready) => void): Disposable {
    return this.listen('ready', listener);
  }

  /** Every final attach answer, failed ones included (as `error`). */
  onStatus(listener: (status: AttachStatus) => void): Disposable {
    return this.listen('status', listener);
  }

  onDiagnostics(listener: (diagnostics: unknown[]) => void): Disposable {
    return this.listen('diagnostics', listener);
  }

  onRefresh(listener: (kinds: string[]) => void): Disposable {
    return this.listen('refresh', listener);
  }

  onReveal(listener: (range: LspRange) => void): Disposable {
    return this.listen('reveal', listener);
  }

  /** A user request could not be served because Orca is holding this plugin's calls back. */
  onBusy(listener: () => void): Disposable {
    return this.listen('busy', listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    clearTimeout(this.syncTimer);
    clearTimeout(this.reattachTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.refreshTimer);
    this.stopPinging();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.send('phpantom.close', { docId: this.docId }).catch(() => {});
  }

  // --- attaching ---

  /** Queues a fresh open (or a resync) behind whatever runs; an open still sending chunks stops at the next one. */
  private async start(resync: boolean): Promise<AttachStatus | null> {
    const generation = ++this.generation;
    if (!resync) {
      this.targetWorkspace = this.context?.workspaceId ?? null;
      this.retryable = false;
      clearTimeout(this.retryTimer);
    }
    const run = this.inLane(async () => this.open(generation, resync));
    if (!resync) this.latest = run;
    return run;
  }

  /** The answer of `run`, or of whatever attempt superseded it. */
  private async settled(run: Promise<AttachStatus | null>): Promise<AttachStatus> {
    let status = await run;
    while (status === null && !this.disposed && this.latest && this.latest !== run) {
      run = this.latest;
      status = await run;
    }
    return status ?? this.current ?? { state: 'error', message: 'PHPantom: the editor closed' };
  }

  private async open(generation: number, resync: boolean): Promise<AttachStatus | null> {
    if (generation !== this.generation || this.disposed) return null;
    const { context } = this;
    // Snapshot and queue reset together: every change after this line is queued on top of `text`.
    const text = this.source.getText();
    this.queue = [];
    this.unsent = [];
    this.needsResync = false;
    this.accepting = true;
    if (!resync) {
      this.attachedTo = null;
      this.stopPinging();
    }
    const chunks = chunkText(text);
    let answer: AttachStatus = { state: 'pending' };
    let cut = false;
    try {
      for (let index = 0; index < chunks.length; index++) {
        const last = index === chunks.length - 1;
        const input: PluginRequestInput<'phpantom.open'> = {
          docId: this.docId,
          language: this.source.language,
          workspaceId: context?.workspaceId ?? null,
          branch: context?.branch ?? null,
          displayName: context?.displayName ?? null,
          index,
          chunk: chunks[index],
          last,
          ...(resync ? { resync: true as const } : {}),
        };
        for (;;) {
          try {
            answer = await this.send(
              'phpantom.open',
              input,
              last ? { timeoutMs: LAST_CHUNK_TIMEOUT_MS } : undefined
            );
            break;
          } catch (error) {
            // Orca refused the chunk before the worker saw it: the same chunk goes again after the hold.
            if (!isRateLimited(error) || generation !== this.generation || this.disposed) {
              throw error;
            }
            await sleep(Math.max(this.pacer.wait(), 1));
            if (generation !== this.generation || this.disposed) return null;
          }
        }
        if (generation !== this.generation) return null;
        if (!last && answer.state !== 'pending') {
          // The worker lost the earlier chunks (it restarted between them): this text never arrived whole.
          cut = true;
          break;
        }
      }
    } catch (error) {
      if (generation !== this.generation) return null;
      answer = { state: 'error', message: `PHPantom did not answer: ${messageOf(error)}` };
      cut = codeOf(error) === 'unavailable';
    }
    if (cut && this.broken === 0) {
      // Once, at once: a worker that restarted mid-sequence takes a fresh sequence.
      this.broken += 1;
      this.generation += 1;
      this.detach();
      void this.reattachNow();
      return null;
    }
    if (answer.state === 'ready') {
      const fresh =
        !this.attachedTo ||
        this.attachedTo.session !== answer.session ||
        this.attachedTo.uri !== answer.uri;
      this.attachedTo = answer;
      this.version = 1;
      this.sentLength = text.length;
      this.retries = 0;
      this.broken = 0;
      this.retryable = false;
      clearTimeout(this.retryTimer);
      this.startPinging();
      if (fresh) {
        this.settle(answer);
        this.emit('ready', answer);
      }
      if (answer.reveal) this.emit('reveal', answer.reveal);
      if (this.queue.length > 0 || this.needsResync) this.scheduleSync(0);
      return answer;
    }
    this.detach();
    const final: AttachStatus =
      answer.state === 'pending'
        ? { state: 'error', message: 'PHPantom: the open never finished' }
        : answer;
    this.settle(final);
    // Only a remote file stays as it is; the rest may attach once saved, after a fix, or once the worker is back.
    if (final.state !== 'remote') {
      this.retryable = true;
      this.retryEarliest = Date.now() + this.retryGapMs;
    }
    return final;
  }

  /** The worker no longer holds this document: forget the session and open it again after the gap. */
  private lost(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.detach();
    void this.reattachNow();
  }

  private detach(): void {
    const had = this.attachedTo !== null;
    this.attachedTo = null;
    this.stopPinging();
    if (this.current?.state === 'ready') this.current = null;
    this.accepting = false;
    this.queue = [];
    this.unsent = [];
    this.needsResync = false;
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    // Markers from a server that no longer has this document would never be cleared otherwise.
    if (had) this.emit('diagnostics', []);
  }

  /** One re-attach at a time, at most one per gap; resolves whether it attached. */
  private async reattachNow(): Promise<boolean> {
    if (this.reattaching !== null) return this.reattaching;
    const delay = Math.max(0, this.lastReattachAt + this.reattachGapMs - Date.now());
    this.reattaching = new Promise<boolean>((resolve) => {
      this.reattachTimer = setTimeout(() => {
        this.lastReattachAt = Date.now();
        this.settled(this.start(false)).then(
          (status) => {
            resolve(status.state === 'ready');
          },
          () => {
            resolve(false);
          }
        );
      }, delay);
    }).finally(() => {
      this.reattaching = null;
    });
    return this.reattaching;
  }

  /**
   * After a failed attempt: try again `delay` after a reason to (typing stopped, the tab showed, a save,
   * a settings change), not sooner than the gap. Typing and showing spend the budget; a save or a settings
   * change (`fresh`) refills it, since either can be what makes the next attempt work.
   */
  private retrySoon(delay: number, fresh: boolean): void {
    if (this.disposed || !this.retryable) return;
    if (fresh) this.retries = 0;
    if (this.retries >= this.maxRetries) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => {
        if (this.disposed || !this.retryable || this.attachedTo) return;
        this.retries += 1;
        void this.start(false);
      },
      Math.max(delay, this.retryEarliest - Date.now())
    );
  }

  // --- the lease ---

  // Why: Orca remounts an editor frame (with a new docId) each time its tab shows, and the old frame's
  // Pagehide close may never reach the worker, so the worker releases what it stops hearing from.
  private startPinging(): void {
    if (this.pingTimer !== undefined || this.disposed) return;
    const timer: { unref?: () => void } | number = setInterval(() => void this.ping(), this.pingMs);
    // Why: under Node (the tests) a bridge never disposed must not keep the process alive; a browser timer is a number.
    if (typeof timer === 'object') timer.unref?.();
    this.pingTimer = timer as ReturnType<typeof setInterval>;
  }

  private stopPinging(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.pinging = null;
  }

  /** Not in the lane: it must not wait behind a long open. A released document goes the way of a lost one. */
  private async ping(): Promise<void> {
    const attachment = this.attachedTo;
    // Why skip during a hold: the lease is three minutes and a ping goes every 20 s.
    if (!attachment || this.pinging || this.disposed || this.pacer.wait() > 0) return;
    const token = {};
    this.pinging = token;
    const { generation } = this;
    let released: boolean;
    try {
      // Why the timeout: a ping that hangs would otherwise swallow every tick after it.
      const answer = await this.send(
        'phpantom.ping',
        { docId: this.docId, session: attachment.session },
        { timeoutMs: this.pingMs }
      );
      released = 'detached' in answer;
    } catch (error) {
      // Only a missing worker means the document is gone; a timeout says nothing about it.
      released = codeOf(error) === 'unavailable';
    } finally {
      if (this.pinging === token) this.pinging = null;
    }
    if (
      released &&
      generation === this.generation &&
      this.attachedTo === attachment &&
      !this.disposed
    ) {
      this.lost();
    }
  }

  // --- the workspace (R2) ---

  private workspaceChanged(context: WorkspaceContext | null): void {
    this.lastSwitchAt = Date.now();
    if (this.mountMoved || this.confirmed || Date.now() - this.mountedAt > this.mountWindowMs) {
      return;
    }
    const id = context?.workspaceId ?? null;
    if (id === null) return;
    if (this.targetWorkspace === undefined) {
      // No open yet: the first one uses this.
      this.context = context;
      this.contextFromEvent = true;
      return;
    }
    if (id === this.targetWorkspace) return;
    this.mountMoved = true;
    this.retarget(context);
  }

  private async confirmWorkspace(): Promise<void> {
    // Why wait: just after a switch readContext still answers the previous workspace for up to 1.3 s.
    for (;;) {
      const due = Math.max(this.mountedAt, this.lastSwitchAt) + this.settleMs - Date.now();
      if (due <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, due));
      if (this.disposed) return;
    }
    const context = await this.host.readContext().catch(() => null);
    if (this.disposed || this.confirmed) return;
    this.confirmed = true;
    const id = context?.workspaceId ?? null;
    if (id !== null && this.targetWorkspace !== undefined && id !== this.targetWorkspace) {
      this.retarget(context);
    }
  }

  /** Opens again under `context` now: not a recovery, so neither the gap nor the retry count apply. */
  private retarget(context: WorkspaceContext | null): void {
    this.context = context;
    this.detach();
    void this.start(false);
  }

  // --- changes ---

  private changed(changes: SourceChange[], isFlush: boolean): void {
    this.lastChangeAt = Date.now();
    if (!this.accepting) {
      this.retrySoon(this.quietMs, false);
      return;
    }
    if (isFlush) {
      this.needsResync = true;
      this.queue = [];
    } else if (!this.needsResync) {
      this.queue.push({ changes, lengthAfter: this.source.getLength() });
    }
    // Why not restart a running timer: steady typing must still go out every syncDelayMs, not only when it stops.
    if (this.syncTimer === undefined) this.scheduleSync(this.syncDelayMs);
  }

  private scheduleSync(delay: number): void {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.flush(false);
    }, delay);
  }

  /**
   * Sends what is queued, behind any open in flight. `drain` (a request about to go out) also sends edits
   * typed meanwhile; the timer sends one batch, and edits typed during it wait for the timer they armed.
   */
  private async flush(drain: boolean): Promise<unknown> {
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    return this.inLane(async () => this.sync(drain));
  }

  private async sync(drain: boolean): Promise<void> {
    while (this.attachedTo && !this.disposed) {
      const { generation } = this;
      if (this.needsResync) {
        await this.open(++this.generation, true);
        continue;
      }
      let groups: Group[];
      const held = this.unsent.length > 0;
      if (held) {
        groups = this.unsent;
        this.unsent = [];
      } else {
        if (this.queue.length === 0) return;
        // Every queued event in one go: their changes apply one after another, as LSP applies a list.
        const events = this.queue.splice(0);
        const split = groupsOf({
          changes: events.flatMap((event) => event.changes),
          lengthAfter: events[events.length - 1].lengthAfter,
        });
        // Why check the start: a length that does not chain on from the last one means the queue missed something.
        if (!split || split.lengthBefore !== this.sentLength) {
          this.resyncNext();
          continue;
        }
        ({ groups } = split);
      }
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index];
        if (this.pacer.wait() > 0) {
          this.holdBack(groups.slice(index));
          return;
        }
        const { session } = this.attachedTo;
        let answer: PluginRequestOutput<'phpantom.change'>;
        try {
          answer = await this.send('phpantom.change', {
            docId: this.docId,
            session,
            version: this.version + 1,
            changes: group.changes,
            length: group.length,
          });
        } catch (error) {
          if (generation !== this.generation) return;
          // Refused before the worker saw it, so it did not land: send the same groups after the hold.
          if (isRateLimited(error)) {
            this.holdBack(groups.slice(index));
            return;
          }
          if (codeOf(error) === 'unavailable') {
            this.lost();
            return;
          }
          // Whether it landed is unknown, so send the whole text.
          this.resyncNext();
          break;
        }
        if (generation !== this.generation || !this.attachedTo) return;
        if ('detached' in answer) {
          this.lost();
          return;
        }
        if ('resync' in answer) {
          this.resyncNext();
          break;
        }
        this.version += 1;
        this.sentLength = group.length;
      }
      if (!drain && !held && !this.needsResync) return;
    }
  }

  private holdBack(groups: Group[]): void {
    this.unsent = groups;
    this.scheduleSync(Math.max(this.pacer.wait(), 1));
  }

  private resyncNext(): void {
    this.needsResync = true;
    this.queue = [];
    this.unsent = [];
  }

  // --- pacing ---

  /** Every call to the worker goes through here, so the pacer sees each one and every refusal. */
  private async send<K extends keyof PluginRequests>(
    name: K,
    input: PluginRequestInput<K>,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<PluginRequestOutput<K>> {
    try {
      const output = await this.host.request(name, input, options);
      this.pacer.succeeded();
      return output;
    } catch (error) {
      if (isRateLimited(error)) this.pacer.refused(error);
      throw error;
    }
  }

  /** Asks Monaco for colouring and hints again once the hold ends (or the share frees), once. */
  private refreshLater(): void {
    if (this.refreshTimer !== undefined || this.disposed) return;
    this.refreshTimer = setTimeout(
      () => {
        this.refreshTimer = undefined;
        if (!this.disposed && this.attachedTo) {
          this.emit('refresh', ['semanticTokens', 'inlayHints']);
        }
      },
      Math.max(this.pacer.wait(), 1000)
    );
  }

  /** Waits out a short hold; a longer one says the editor is busy and answers false. */
  private async holdPassed(signal?: AbortSignal, silent = false): Promise<boolean> {
    const hold = this.pacer.wait();
    if (hold === 0) return true;
    if (hold > this.userMaxWaitMs) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- emit() takes the payload as a required argument
      if (!silent) this.emit('busy', undefined);
      return false;
    }
    await sleep(hold, signal);
    return !signal?.aborted && !this.disposed;
  }

  /** A user call: after the hold, and once more if Orca refuses it; null when it fails. */
  private async userCall<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
    for (let refused = false; ; refused = true) {
      if (!(await this.holdPassed(signal))) return null;
      try {
        return await run();
      } catch (error) {
        if (!isRateLimited(error) || signal?.aborted) return null;
        if (refused) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- emit() takes the payload as a required argument
          this.emit('busy', undefined);
          return null;
        }
      }
    }
  }

  /**
   * Waits `backgroundMinWaitMs`, and until typing paused for `backgroundQuietMs`. False when aborted or when
   * the text moved past `version` meanwhile: Monaco asks again after a change.
   */
  private async typingPaused(version: number, signal?: AbortSignal): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      if (signal?.aborted || this.disposed || this.source.getVersion() !== version) return false;
      const settledIn =
        Math.max(this.lastChangeAt + this.backgroundQuietMs, started + this.backgroundMinWaitMs) -
        Date.now();
      if (settledIn <= 0) return true;
      await sleep(settledIn, signal);
    }
  }

  // --- plumbing ---

  private async inLane<T>(job: () => Promise<T>): Promise<T> {
    const run = this.lane.then(job, job);
    this.lane = run.catch(() => {});
    return run;
  }

  private settle(status: AttachStatus): void {
    this.current = status;
    this.emit('status', status);
  }

  private listen<K extends keyof Events>(
    kind: K,
    listener: (value: Events[K]) => void
  ): Disposable {
    const set = this.listeners[kind];
    set.add(listener);
    return { dispose: () => void set.delete(listener) };
  }

  private emit<K extends keyof Events>(kind: K, value: Events[K]): void {
    for (const listener of [...this.listeners[kind]]) {
      try {
        listener(value);
      } catch (error) {
        console.error(`PHPantom ${kind} listener failed`, error);
      }
    }
  }
}
