import { randomUUID } from 'node:crypto';

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Params } from 'nestjs-pino';

/**
 * Pino logging config (Master Context §2). JSON logs, one correlation id per
 * request, and hard redaction of PII / banking / tokens (§2, §3 — never log
 * secrets or full tokens).
 */
export function buildLoggerParams(level: string): Params {
  return {
    pinoHttp: {
      level,
      genReqId: (req: IncomingMessage, res: ServerResponse): string => {
        const header = req.headers['x-correlation-id'];
        const id = (Array.isArray(header) ? header[0] : header) ?? randomUUID();
        res.setHeader('x-correlation-id', id);
        return id;
      },
      customProps: () => ({ context: 'HTTP' }),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-portal"]',
          'req.body.password',
          'req.body.refreshToken',
          'req.body.mfaCode',
          'res.headers["set-cookie"]',
          '*.password',
          '*.argonHash',
          '*.argon_hash',
          '*.mfaSecret',
          '*.accessToken',
          '*.refreshToken',
          '*.accountNoEncrypted',
        ],
        remove: true,
      },
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url === '/health',
      },
      // Pretty-printing uses a pino worker-thread transport that resolves its
      // target module at runtime — this fails inside serverless bundles (e.g.
      // Vercel's /var/task), crashing PinoLogger on boot. Only enable it for
      // genuine local dev, never on a serverless platform, so a stray
      // NODE_ENV=development in a deployed env can't take the app down.
      transport:
        process.env.NODE_ENV === 'development' && !process.env.VERCEL
          ? { target: 'pino-pretty', options: { singleLine: true } }
          : undefined,
    },
  };
}
