import { describe, expect, it } from 'vitest';

import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

/** Breaker with no real backoff sleeps + a controllable clock, for fast tests. */
class TestBreaker extends CircuitBreaker {
  clockMs = 0;
  constructor(opts?: ConstructorParameters<typeof CircuitBreaker>[0]) {
    super(opts);
    this.now = () => this.clockMs;
  }
  protected override sleep(): Promise<void> {
    return Promise.resolve();
  }
}

describe('CircuitBreaker (ADR-032)', () => {
  it('retries transient failures then succeeds within one call', async () => {
    const b = new TestBreaker({ attempts: 3 });
    let n = 0;
    const result = await b.run('k', async () => {
      n += 1;
      if (n < 3) throw new Error('transient');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(n).toBe(3);
    expect(b.stateOf('k')).toBe('CLOSED');
  });

  it('trips OPEN after the failure threshold and then fast-fails', async () => {
    const b = new TestBreaker({ attempts: 1, failureThreshold: 3, cooldownMs: 1000 });
    for (let i = 0; i < 3; i += 1) {
      await expect(b.run('p', () => Promise.reject(new Error('down')))).rejects.toThrow(
        'down',
      );
    }
    expect(b.stateOf('p')).toBe('OPEN');
    // Now OPEN → fast-fail without invoking fn.
    let called = false;
    await expect(
      b.run('p', async () => {
        called = true;
        return 'x';
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it('moves OPEN → HALF_OPEN after cooldown and closes on a successful trial', async () => {
    const b = new TestBreaker({ attempts: 1, failureThreshold: 2, cooldownMs: 500 });
    await expect(b.run('h', () => Promise.reject(new Error('e')))).rejects.toThrow();
    await expect(b.run('h', () => Promise.reject(new Error('e')))).rejects.toThrow();
    expect(b.stateOf('h')).toBe('OPEN');
    b.clockMs += 600; // elapse cooldown
    const out = await b.run('h', () => Promise.resolve('recovered'));
    expect(out).toBe('recovered');
    expect(b.stateOf('h')).toBe('CLOSED');
  });

  it('isolates keys — one provider tripping does not affect another', async () => {
    const b = new TestBreaker({ attempts: 1, failureThreshold: 1 });
    await expect(b.run('a', () => Promise.reject(new Error('e')))).rejects.toThrow();
    expect(b.stateOf('a')).toBe('OPEN');
    expect(b.stateOf('b')).toBe('CLOSED');
    await expect(b.run('b', () => Promise.resolve('fine'))).resolves.toBe('fine');
  });
});
