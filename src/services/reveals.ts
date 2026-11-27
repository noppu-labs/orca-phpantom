// Where to put the cursor in a file the person is navigating to.
// The editor that opens the file attaches later, so the range waits here until that open takes it, or goes stale.
import type { LspRange } from '../protocol.ts';

const MAX_ENTRIES = 5;

class PendingReveals {
  private readonly entries = new Map<string, { range: LspRange; at: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = 30_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  add(path: string, range: LspRange): void {
    // Why delete first: a re-added path becomes the newest, so it is the last to be dropped.
    this.entries.delete(path);
    this.entries.set(path, { range, at: this.now() });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  paths(): string[] {
    this.prune();
    return [...this.entries.keys()];
  }

  take(path: string): LspRange | null {
    this.prune();
    const entry = this.entries.get(path);
    this.entries.delete(path);
    return entry?.range ?? null;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const oldest = this.now() - this.ttlMs;
    for (const [path, entry] of this.entries) {
      if (entry.at < oldest) {
        this.entries.delete(path);
      }
    }
  }
}

export { PendingReveals };
