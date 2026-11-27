// Every post to an editor goes through here, so the plugin stays inside Orca's limits (200 posts per
// 10 s, 256 KiB each, measured by Orca's own function: see size.ts) even when PHPantom publishes diagnostics for hundreds of files at once.
// Posts are keyed: a newer payload for a key replaces the queued one, so the latest state always arrives and stale ones are never sent.

import { ORCA_SLOT_BYTES } from '../constants/orca-measure.ts';
import { BYTES_PER_KIB } from '../constants/units.ts';
import { isRecord } from '../utils/json.ts';
import { fitsIn, orcaSize, type Size } from '../utils/size.ts';

// Orca drops a post over 256 KiB or 10,000 objects by its own measure; this leaves room for what it may miss.
const DEFAULT_MAX_KIB = 250;
const DEFAULT_MAX_OBJECTS = 9000;
// Orca's 200 posts per 10 s, with room to spare, and how long a send waits before the queue goes out, so sends close together go out together.
const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_MAX_POSTS = 180;
const DEFAULT_DELAY_MS = 150;
// The most UTF-8 bytes one UTF-16 unit of a message can take.
const MAX_BYTES_PER_UNIT = 4;

interface OutboxOptions {
  windowMs?: number;
  maxPosts?: number;
  maxBytes?: number;
  maxObjects?: number;
  delayMs?: number;
  now?: () => number;
}

type PostFn = (event: string, payload: unknown, options: { panel: string }) => void;
interface Queued {
  panel: string;
  event: string;
  payload: unknown;
}
interface DiagnosticsPayload {
  diagnostics: unknown[];
  truncated?: number;
}

const isDiagnosticsPayload = (payload: unknown): payload is DiagnosticsPayload =>
  isRecord(payload) && Array.isArray(payload.diagnostics);

function severityOf(diagnostic: unknown): number {
  const severity = isRecord(diagnostic) ? diagnostic.severity : undefined;
  // Why 1: clients show a diagnostic without a severity as an error.
  return typeof severity === 'number' ? severity : 1;
}

class Outbox {
  private readonly post: PostFn;
  private readonly windowMs: number;
  private readonly maxPosts: number;
  private readonly limit: Size;
  private readonly delayMs: number;
  private readonly now: () => number;
  private readonly queue = new Map<string, Queued>();
  private readonly sent: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  public constructor(post: PostFn, options: OutboxOptions = {}) {
    this.post = post;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxPosts = options.maxPosts ?? DEFAULT_MAX_POSTS;
    this.limit = {
      bytes: options.maxBytes ?? DEFAULT_MAX_KIB * BYTES_PER_KIB,
      objects: options.maxObjects ?? DEFAULT_MAX_OBJECTS,
    };
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.now = options.now ?? Date.now;
  }

  public send(panel: string, key: string, event: string, payload: unknown): void {
    if (this.disposed) {
      return;
    }
    // Why set on the existing key: Map keeps its first position, so a busy key cannot starve the others.
    this.queue.set(key, { event, panel, payload });
    this.arm(this.delayMs);
  }

  /** The payload waiting under `key`, so a caller can merge into it. */
  public queued(key: string): unknown {
    return this.queue.get(key)?.payload;
  }

  /** Forgets what waits under `key`, so it is never sent. */
  public drop(key: string): void {
    this.queue.delete(key);
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue.clear();
  }

  private arm(ms: number): void {
    if (this.timer || this.disposed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, ms);
    this.timer.unref?.();
  }

  private flush(): void {
    const now = this.now();
    while (this.sent.length > 0 && this.sent[0] <= now - this.windowMs) {
      this.sent.shift();
    }
    for (const [key, item] of this.queue) {
      if (this.sent.length >= this.maxPosts) {
        break;
      }
      this.queue.delete(key);
      this.sent.push(now);
      try {
        this.post(item.event, this.fit(item.event, item.payload), { panel: item.panel });
      } catch {
        // Why swallow: a post is fire and forget; one refused post must not stop the rest.
      }
    }
    if (this.queue.size > 0) {
      // Why from `now()` and re-checked on firing: the window frees when its oldest post ages out.
      const wait = this.sent.length >= this.maxPosts ? this.sent[0] + this.windowMs - now : 0;
      this.arm(Math.max(wait, 1));
    }
  }

  /** A payload over Orca's limit is cut to what fits: diagnostics keep the most severe, a message is shortened. */
  private fit(event: string, payload: unknown): unknown {
    if (fitsIn(orcaSize(payload), this.limit)) {
      return payload;
    }
    if (event === 'phpantom.diagnostics') {
      // Why throw: the router queues diagnostics only as a list, and flush skips a post whose fit throws.
      if (!isDiagnosticsPayload(payload)) throw new TypeError('diagnostics payload without a list');
      return this.fitDiagnostics(payload);
    }
    const message = isRecord(payload) ? payload.message : undefined;
    if (isRecord(payload) && typeof message === 'string') {
      const shell = orcaSize({ ...payload, message: '' });
      const room = this.limit.bytes - shell.bytes;
      if (room > 0 && shell.objects <= this.limit.objects) {
        // Why chars before bytes: a character is at most 4 bytes, so this many always fit.
        return { ...payload, message: message.slice(0, Math.floor(room / MAX_BYTES_PER_UNIT)) };
      }
    }
    return payload;
  }

  private fitDiagnostics(original: DiagnosticsPayload): DiagnosticsPayload {
    const earlier = original.truncated ?? 0;
    const ranked = original.diagnostics
      .map((diagnostic, index) => ({ diagnostic, index, severity: severityOf(diagnostic) }))
      .sort((left, right) => left.severity - right.severity || left.index - right.index);
    // Why the largest count: a number is 8 bytes to Orca whatever its value.
    const shell = orcaSize({
      ...original,
      diagnostics: [],
      truncated: earlier + original.diagnostics.length,
    });
    let { bytes } = shell;
    let { objects } = shell;
    const kept: typeof ranked = [];
    for (const entry of ranked) {
      const size = orcaSize(entry.diagnostic);
      if (
        bytes + ORCA_SLOT_BYTES + size.bytes > this.limit.bytes ||
        objects + size.objects > this.limit.objects
      ) {
        break;
      }
      bytes += ORCA_SLOT_BYTES + size.bytes;
      objects += size.objects;
      kept.push(entry);
    }
    kept.sort((left, right) => left.index - right.index);
    return {
      ...original,
      diagnostics: kept.map((entry) => entry.diagnostic),
      truncated: earlier + original.diagnostics.length - kept.length,
    };
  }
}

export { Outbox };
export type { OutboxOptions };
