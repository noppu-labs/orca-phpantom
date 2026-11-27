// Orca refuses frame calls past 120 in 10 s, counted per plugin across all its tabs and windows, with `rate_limited` ("too many panel requests"; Orca 1.4.278 sends no retryAfterMs with it).
// This keeps one editor's share of that budget and holds its calls back after a refusal.
// No Monaco here.
import { isRecord } from '../../src/utils/json.ts';

interface PacerOptions {
  windowMs?: number;
  /** Most passive calls (hover, completion, colouring...) this editor makes in a window. */
  passiveCap?: number;
  /** The first hold after a refusal that names no retryAfterMs; each refusal after a hold doubles it. */
  firstBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

const MIN_HOLD_MS = 250;

const isRateLimited = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'rate_limited';

class Pacer {
  private readonly windowMs: number;
  private readonly passiveCap: number;
  private readonly firstBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  /** When this editor's passive calls went out. */
  private readonly sent: number[] = [];
  private blockedUntil = 0;
  private backoff = 0;

  public constructor(options: PacerOptions = {}) {
    this.windowMs = options.windowMs ?? 10_000;
    this.passiveCap = options.passiveCap ?? 50;
    this.firstBackoffMs = options.firstBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Milliseconds until Orca should take calls again. */
  public wait(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** Whether a passive call may go out now; a yes counts it, so calls asked at once cannot overshoot the cap. */
  public takePassive(): boolean {
    this.prune();
    if (this.wait() > 0 || this.sent.length >= this.passiveCap) return false;
    this.sent.push(this.now());
    return true;
  }

  /** Orca refused a call: holds calls back and answers for how long. */
  public refused(error: unknown): number {
    const now = this.now();
    // Why not escalate during a hold: calls already in flight when it began come back refused too.
    if (now < this.blockedUntil) return this.blockedUntil - now;
    const given = isRecord(error) ? error.retryAfterMs : undefined;
    let hold: number;
    if (typeof given === 'number' && Number.isFinite(given) && given >= 0) {
      // Why clamp: 0 would retry in a tight loop, and a huge value would stall the editor for good.
      hold = Math.min(Math.max(given, MIN_HOLD_MS), this.maxBackoffMs);
    } else {
      this.backoff =
        this.backoff === 0 ? this.firstBackoffMs : Math.min(this.backoff * 2, this.maxBackoffMs);
      hold = this.backoff;
    }
    this.blockedUntil = now + hold;
    return hold;
  }

  public succeeded(): void {
    this.backoff = 0;
  }

  private prune(): void {
    const oldest = this.now() - this.windowMs;
    while (this.sent.length > 0 && this.sent[0] <= oldest) this.sent.shift();
  }
}

export { isRateLimited, Pacer };
export type { PacerOptions };
