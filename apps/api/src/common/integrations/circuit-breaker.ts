/**
 * A tiny per-key circuit breaker + retry helper (Slice 10a, ADR-032).
 *
 * The single most important discipline of Slice 10 is that **no external
 * integration failure may block the core P2P flow**. This breaker enforces that
 * by (a) retrying transient failures with exponential backoff, and (b) tripping
 * OPEN after repeated failures so a dead provider fails fast into the caller's
 * documented manual-fallback path instead of hanging every request.
 *
 * No external dependency (no opossum/cockatiel) — deliberately small and
 * synchronous-state so it is trivially unit-testable and has no Redis coupling.
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerOptions {
  /** Consecutive failures before tripping OPEN. */
  failureThreshold?: number;
  /** How long to stay OPEN before allowing a HALF_OPEN trial (ms). */
  cooldownMs?: number;
  /** Retry attempts per call for transient errors (total tries = attempts). */
  attempts?: number;
  /** Base backoff between attempts (ms); doubles each retry. */
  backoffMs?: number;
}

export class CircuitOpenError extends Error {
  readonly circuitOpen = true;
  constructor(key: string) {
    super(`Circuit breaker OPEN for "${key}"`);
    this.name = 'CircuitOpenError';
  }
}

interface Cell {
  state: BreakerState;
  failures: number;
  openedAt: number;
}

/** Injectable-free registry; one instance is provided as a Nest singleton. */
export class CircuitBreaker {
  private readonly cells = new Map<string, Cell>();
  private readonly opts: Required<BreakerOptions>;
  /** Clock injection point — kept so unit tests are deterministic without timers. */
  now: () => number = () => Date.now();

  constructor(opts: BreakerOptions = {}) {
    this.opts = {
      failureThreshold: opts.failureThreshold ?? 5,
      cooldownMs: opts.cooldownMs ?? 30_000,
      attempts: opts.attempts ?? 3,
      backoffMs: opts.backoffMs ?? 200,
    };
  }

  stateOf(key: string): BreakerState {
    return this.cell(key).state;
  }

  private cell(key: string): Cell {
    let c = this.cells.get(key);
    if (!c) {
      c = { state: 'CLOSED', failures: 0, openedAt: 0 };
      this.cells.set(key, c);
    }
    // OPEN → HALF_OPEN once the cooldown elapses.
    if (c.state === 'OPEN' && this.now() - c.openedAt >= this.opts.cooldownMs) {
      c.state = 'HALF_OPEN';
    }
    return c;
  }

  private trip(c: Cell): void {
    c.state = 'OPEN';
    c.openedAt = this.now();
  }

  private onSuccess(c: Cell): void {
    c.failures = 0;
    c.state = 'CLOSED';
  }

  private onFailure(c: Cell): void {
    c.failures += 1;
    if (c.failures >= this.opts.failureThreshold) this.trip(c);
  }

  /**
   * Run `fn` under the breaker. Throws {@link CircuitOpenError} immediately when
   * OPEN. Retries transient failures with exponential backoff; a HALF_OPEN trial
   * closes the breaker on success or re-opens on failure.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const c = this.cell(key);
    if (c.state === 'OPEN') throw new CircuitOpenError(key);

    let lastErr: unknown;
    const tries = c.state === 'HALF_OPEN' ? 1 : this.opts.attempts;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      try {
        const result = await fn();
        this.onSuccess(c);
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt < tries - 1) {
          await this.sleep(this.opts.backoffMs * 2 ** attempt);
        }
      }
    }
    this.onFailure(c);
    throw lastErr;
  }

  /** Overridable in tests to avoid real timers. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Test/ops helper — force a key back to CLOSED. */
  reset(key: string): void {
    this.cells.set(key, { state: 'CLOSED', failures: 0, openedAt: 0 });
  }
}
