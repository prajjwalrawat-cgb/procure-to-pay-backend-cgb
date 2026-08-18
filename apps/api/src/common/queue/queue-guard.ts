import type { ConfigService } from '@nestjs/config';
import type { JobsOptions, Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';

import type { Env } from '../../config/env';

/**
 * Crash guards for the BullMQ trios (connection + queue + worker) each
 * background service opens in `onModuleInit`.
 *
 * Two ways an unreachable or quota-exhausted Redis used to take the whole API
 * down rather than just the background job:
 *
 *  1. `void queue.add(...)` — an unhandled rejection, which Node >= 15
 *     terminates the process for. A repeatable job scheduled at boot then kills
 *     the server moments after it starts listening, so the platform healthcheck
 *     fails and the deploy is rolled back.
 *  2. An `error` event on an ioredis connection, Queue or Worker with no
 *     listener attached — EventEmitter rethrows it as an uncaught exception.
 *
 * Background jobs are best-effort; HTTP traffic is not. These helpers downgrade
 * both cases to a log line. Errors are throttled per label because ioredis
 * reconnect storms emit continuously and would otherwise flood the logs.
 */

const THROTTLE_MS = 60_000;
const lastLoggedAt = new Map<string, number>();

function logThrottled(key: string, log: (message: string) => void, message: string): void {
  const now = Date.now();
  const previous = lastLoggedAt.get(key);
  if (previous !== undefined && now - previous < THROTTLE_MS) return;
  lastLoggedAt.set(key, now);
  log(message);
}

/** Attach `error` listeners so Redis trouble degrades the job, never the API. */
export function guardBullMq(
  label: string,
  parts: { connection?: IORedis; queue?: Queue; worker?: Worker },
  log: (message: string) => void,
): void {
  const { connection, queue, worker } = parts;
  connection?.on('error', (err: Error) =>
    logThrottled(`${label}:redis`, log, `[${label}] Redis connection error: ${err.message}`),
  );
  queue?.on('error', (err: Error) =>
    logThrottled(`${label}:queue`, log, `[${label}] queue error: ${err.message}`),
  );
  worker?.on('error', (err: Error) =>
    logThrottled(`${label}:worker`, log, `[${label}] worker error: ${err.message}`),
  );
}

/**
 * Schedule a repeatable job without letting a Redis failure reject into the
 * void. Re-adding an existing repeatable is a no-op, so this is safe on every
 * boot.
 */
export function scheduleRepeatable(
  label: string,
  queue: Queue,
  jobName: string,
  opts: JobsOptions,
  log: (message: string) => void,
): void {
  void queue.add(jobName, {}, opts).catch((err: Error) => {
    log(`[${label}] could not schedule repeatable "${jobName}": ${err.message}`);
  });
}

/**
 * Seconds a scheduler's worker spends blocked on Redis per poll (BullMQ's
 * default is 5). A cron job picked up a minute late is harmless, and the longer
 * block cuts that worker's idle command count by roughly 12x.
 */
export const SCHEDULER_DRAIN_DELAY_SECONDS = 60;

/**
 * Whether the repeatable/cron workers should start.
 *
 * `DISABLE_BACKGROUND_JOBS` is the master switch — tests and one-off scripts
 * must open no Redis connection at all. `DISABLE_SCHEDULED_JOBS` narrows that
 * to the always-idle schedulers, so OCR and bulk import keep running: the
 * invoice pipeline needs them (no OCR means no 3-way match, and an unmatched
 * invoice cannot be routed for approval), while the cron workers can wait.
 */
export function schedulersDisabled(config: ConfigService<Env, true>): boolean {
  return (
    config.get('DISABLE_BACKGROUND_JOBS', { infer: true }) ||
    config.get('DISABLE_SCHEDULED_JOBS', { infer: true })
  );
}
