import { describe, it, expect } from 'vitest';
import { LoginThrottle } from '../src/throttle.js';

function fixed() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('LoginThrottle', () => {
  it('locks out after maxFails and reports remaining time', () => {
    const clk = fixed();
    const th = new LoginThrottle({ now: clk.now, maxFails: 3, lockMs: 1000 });
    expect(th.lockedMs('ip1')).toBe(0);
    th.recordFail('ip1');
    th.recordFail('ip1');
    expect(th.lockedMs('ip1')).toBe(0); // 2 < 3
    th.recordFail('ip1');
    expect(th.lockedMs('ip1')).toBe(1000); // tripped
  });

  it('lockout expires after lockMs', () => {
    const clk = fixed();
    const th = new LoginThrottle({ now: clk.now, maxFails: 1, lockMs: 1000 });
    th.recordFail('ip1');
    expect(th.lockedMs('ip1')).toBe(1000);
    clk.advance(1001);
    expect(th.lockedMs('ip1')).toBe(0);
  });

  it('reset clears a key; keys are independent', () => {
    const clk = fixed();
    const th = new LoginThrottle({ now: clk.now, maxFails: 2, lockMs: 1000 });
    th.recordFail('a'); th.recordFail('a');
    th.recordFail('b');
    expect(th.lockedMs('a')).toBe(1000);
    expect(th.lockedMs('b')).toBe(0);
    th.reset('a');
    expect(th.lockedMs('a')).toBe(0);
  });

  it('clear() wipes every key', () => {
    const th = new LoginThrottle({ maxFails: 1, lockMs: 1000 });
    th.recordFail('a');
    th.recordFail('b');
    th.clear();
    expect(th.lockedMs('a')).toBe(0);
    expect(th.lockedMs('b')).toBe(0);
  });
});
