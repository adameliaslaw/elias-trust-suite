import { describe, it, expect } from 'vitest';
import { SessionStore } from '../src/sessions.js';

// A controllable clock + deterministic token source keep these tests exact.
function fixed() {
  let t = 1_000_000;
  let n = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    mintToken: () => `tok${++n}`,
  };
}

describe('SessionStore', () => {
  it('creates a valid session and slides the idle window', () => {
    const clk = fixed();
    const store = new SessionStore({ now: clk.now, mintToken: clk.mintToken, idleMs: 1000, absoluteMs: 10000 });
    const token = store.create('jane');
    expect(store.validate(token)).toBe(true);
    clk.advance(900); // within idle window
    expect(store.validate(token)).toBe(true); // slides lastSeen
    clk.advance(900); // < idle since the slide
    expect(store.validate(token)).toBe(true);
  });

  it('expires an idle session', () => {
    const clk = fixed();
    const store = new SessionStore({ now: clk.now, mintToken: clk.mintToken, idleMs: 1000, absoluteMs: 100000 });
    const token = store.create(null);
    clk.advance(1001);
    expect(store.validate(token)).toBe(false);
    expect(store.sessions.has(token)).toBe(false); // evicted
  });

  it('enforces the absolute cap even with activity', () => {
    const clk = fixed();
    const store = new SessionStore({ now: clk.now, mintToken: clk.mintToken, idleMs: 1000, absoluteMs: 2500 });
    const token = store.create('jane');
    clk.advance(900); expect(store.validate(token)).toBe(true);
    clk.advance(900); expect(store.validate(token)).toBe(true);
    clk.advance(900); // total 2700 > absolute 2500
    expect(store.validate(token)).toBe(false);
  });

  it('distinguishes the default owner (null) from a named principal', () => {
    const store = new SessionStore();
    const owner = store.create();
    const named = store.create('bob');
    expect(store.principal(owner)).toEqual({ username: null });
    expect(store.principal(named)).toEqual({ username: 'bob' });
  });

  it('destroy() ends one session; clear() ends all', () => {
    const store = new SessionStore();
    const a = store.create('a');
    const b = store.create('b');
    store.destroy(a);
    expect(store.validate(a)).toBe(false);
    expect(store.validate(b)).toBe(true);
    store.clear();
    expect(store.validate(b)).toBe(false);
  });

  it('validate/principal return falsey for unknown or empty tokens', () => {
    const store = new SessionStore();
    expect(store.validate(undefined)).toBe(false);
    expect(store.validate('nope')).toBe(false);
    expect(store.principal(null)).toBeUndefined();
  });
});
