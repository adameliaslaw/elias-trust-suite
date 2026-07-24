// Server-side session store: opaque bearer tokens mapped to a principal, with a
// sliding idle window and a hard absolute cap. Lifted from books' auth so every
// app expires and invalidates sessions identically.
//
// Sessions live only in memory, so a restart logs everyone out (a deliberate,
// cheap "panic logout"). Each token also dies on its own once idle past
// `idleMs` or older than `absoluteMs`, and the whole store can be cleared at
// once — books does that on a password change so a stolen cookie cannot outlive
// the password it was minted under.
//
// A session binds a token to a `username`. `null` means the DEFAULT OWNER — the
// household-shared password that predates named principals — so the pre-roles
// login path keeps working unchanged. A non-null string names a principal the
// app resolves to a role.

import { randomBytes } from 'node:crypto';

export interface SessionRecord {
  createdAt: number;
  lastSeen: number;
  /** Principal username, or null for the default (household-password) owner. */
  username: string | null;
}

export interface PrincipalRef {
  username: string | null;
}

export interface SessionStoreOptions {
  /** Sliding inactivity window; a session unused this long expires. */
  idleMs?: number;
  /** Hard ceiling from creation; should match the cookie Max-Age. */
  absoluteMs?: number;
  /** Injectable clock (tests); defaults to `Date.now`. */
  now?: () => number;
  /** Injectable token source (tests); defaults to 32 random bytes, hex. */
  mintToken?: () => string;
}

const DEFAULT_IDLE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, matches cookie Max-Age

export class SessionStore {
  /** token -> record. Exposed so an app can surface it as a test hook. */
  readonly sessions = new Map<string, SessionRecord>();

  readonly idleMs: number;
  readonly absoluteMs: number;
  private readonly now: () => number;
  private readonly mintToken: () => string;

  constructor(options: SessionStoreOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.absoluteMs = options.absoluteMs ?? DEFAULT_ABSOLUTE_MS;
    this.now = options.now ?? Date.now;
    this.mintToken = options.mintToken ?? defaultMintToken;
  }

  /**
   * Create a session for `username` (null = default owner) and return its
   * token. Callers set the token as an HttpOnly cookie.
   */
  create(username: string | null = null): string {
    const token = this.mintToken();
    const t = this.now();
    this.sessions.set(token, {
      createdAt: t,
      lastSeen: t,
      username: username == null ? null : String(username),
    });
    return token;
  }

  /**
   * True if `token` names a live session. Slides the idle window on success;
   * evicts and returns false once idle- or absolute-expired.
   */
  validate(token: string | null | undefined): boolean {
    const s = token ? this.sessions.get(token) : undefined;
    if (!s) return false;
    const t = this.now();
    if (t - s.lastSeen > this.idleMs || t - s.createdAt > this.absoluteMs) {
      this.sessions.delete(token as string);
      return false;
    }
    s.lastSeen = t;
    return true;
  }

  /**
   * The principal for a live token, or undefined if missing/expired. Validates
   * (and thus slides / evicts) as a side effect, matching books' behavior.
   */
  principal(token: string | null | undefined): PrincipalRef | undefined {
    if (!this.validate(token)) return undefined;
    const s = this.sessions.get(token as string);
    return s ? { username: s.username } : undefined;
  }

  /** Drop a single session (logout). */
  destroy(token: string | null | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** Drop every session (password change / global sign-out). */
  clear(): void {
    this.sessions.clear();
  }
}

function defaultMintToken(): string {
  return randomBytes(32).toString('hex');
}
