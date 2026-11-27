// Every post to an editor goes through here, so the plugin stays inside Orca's limits (200 posts per
// 10 s, 256 KiB each, measured by Orca's own function: see size.ts) even when PHPantom publishes diagnostics for hundreds of files at once.
// Posts are keyed: a newer payload for a key replaces the queued one, so the latest state always arrives and stale ones are never sent.

import { fitsIn, orcaSize, type Size } from '../utils/size.ts';

// Orca drops a post over 256 KiB or 10,000 objects by its own measure; this leaves room for what it may miss.
export interface OutboxOptions {
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

function severityOf(diagnostic: unknown): number {
  const severity = (diagnostic as { severity?: unknown } | null)?.severity;
  // Why 1: clients show a diagnostic without a severity as an error.
  return typeof severity === 'number' ? severity : 1;
}

export class Outbox {
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

  constructor(post: PostFn, options: OutboxOptions = {}) {
    this.post = post;
    this.windowMs = options.windowMs ?? 10_000;
    this.maxPosts = options.maxPosts ?? 180;
    this.limit = { bytes: options.maxBytes ?? 250 * 1024, objects: options.maxObjects ?? 9000 };
    this.delayMs = options.delayMs ?? 150;
    this.now = options.now ?? Date.now;
  }

  send(panel: string, key: string, event: string, payload: unknown): void {
    if (this.disposed) {
      return;
    }
    // Why set on the existing key: Map keeps its first position, so a busy key cannot starve the others.
    this.queue.set(key, { panel, event, payload });
    this.arm(this.delayMs);
  }

  /** The payload waiting under `key`, so a caller can merge into it. */
  queued(key: string): unknown {
    return this.queue.get(key)?.payload;
  }

  /** Forgets what waits under `key`, so it is never sent. */
  drop(key: string): void {
    this.queue.delete(key);
  }

  dispose(): void {
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
      return this.fitDiagnostics(payload as DiagnosticsPayload);
    }
    const message = (payload as { message?: unknown } | null)?.message;
    if (typeof message === 'string') {
      const shell = orcaSize({ ...(payload as object), message: '' });
      const room = this.limit.bytes - shell.bytes;
      if (room > 0 && shell.objects <= this.limit.objects) {
        // Why chars before bytes: a character is at most 4 bytes, so this many always fit.
        return { ...(payload as object), message: message.slice(0, Math.floor(room / 4)) };
      }
    }
    return payload;
  }

  private fitDiagnostics(original: DiagnosticsPayload): DiagnosticsPayload {
    const earlier = original.truncated ?? 0;
    const ranked = original.diagnostics
      .map((diagnostic, index) => ({ diagnostic, index, severity: severityOf(diagnostic) }))
      .sort((a, b) => a.severity - b.severity || a.index - b.index);
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
        bytes + 4 + size.bytes > this.limit.bytes ||
        objects + size.objects > this.limit.objects
      ) {
        break;
      }
      bytes += 4 + size.bytes;
      objects += size.objects;
      kept.push(entry);
    }
    kept.sort((a, b) => a.index - b.index);
    return {
      ...original,
      diagnostics: kept.map((entry) => entry.diagnostic),
      truncated: earlier + original.diagnostics.length - kept.length,
    };
  }
}
