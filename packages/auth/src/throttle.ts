// Brute-force login throttle: after `maxFails` failures for a given key the key
// is locked out for `lockMs`. Lifted from books' auth so every app rate-limits
// login the same way.
//
// The key is opaque to this module — books passes the client IP (the socket
// address, never a spoofable X-Forwarded-For). Behind a shared proxy every
// client collapses to one key and the lockout applies to the proxy as a whole;
// that still caps brute forcing, which is the point.

export interface LoginThrottleOptions {
  /** Failures allowed before a lockout trips. */
  maxFails?: number;
  /** Lockout duration once tripped. */
  lockMs?: number;
  /** Injectable clock (tests); defaults to `Date.now`. */
  now?: () => number;
}

interface Attempt {
  fails: number;
  lockedUntil: number;
}

const DEFAULT_MAX_FAILS = 5;
const DEFAULT_LOCK_MS = 15 * 60 * 1000; // 15 minutes

export class LoginThrottle {
  readonly maxFails: number;
  readonly lockMs: number;
  private readonly now: () => number;
  private readonly attempts = new Map<string, Attempt>();

  constructor(options: LoginThrottleOptions = {}) {
    this.maxFails = options.maxFails ?? DEFAULT_MAX_FAILS;
    this.lockMs = options.lockMs ?? DEFAULT_LOCK_MS;
    this.now = options.now ?? Date.now;
  }

  /** Milliseconds remaining on `key`'s lockout, or 0 if it may try now. */
  lockedMs(key: string): number {
    const rec = this.attempts.get(key);
    if (rec && rec.lockedUntil > this.now()) return rec.lockedUntil - this.now();
    return 0;
  }

  /**
   * Record a failed attempt for `key`. Once failures reach `maxFails` the key
   * locks for `lockMs` and the failure counter resets (so the next lockout
   * needs a fresh run of failures).
   */
  recordFail(key: string): void {
    const rec = this.attempts.get(key) ?? { fails: 0, lockedUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= this.maxFails) {
      rec.lockedUntil = this.now() + this.lockMs;
      rec.fails = 0;
    }
    this.attempts.set(key, rec);
  }

  /** Clear `key`'s failure/lockout state (called on a successful login). */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  /** Clear every key's state. */
  clear(): void {
    this.attempts.clear();
  }
}
