import { z } from 'zod';

/**
 * Validated environment. The app refuses to boot if anything required is
 * missing (Master Context §3 rule #7 — secrets from env, never code).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(3001),
  API_CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3002'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // When true, background BullMQ workers (OCR, SLA) are not started — used by
  // tests and one-off scripts that must not open Redis connections.
  DISABLE_BACKGROUND_JOBS: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().default('procureflow-dev'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  JWT_PRIVATE_KEY_BASE64: z.string().min(1),
  JWT_PUBLIC_KEY_BASE64: z.string().min(1),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  JWT_ISSUER: z.string().default('procureflow.io'),
  JWT_BUYER_AUDIENCE: z.string().default('buyer'),
  JWT_VENDOR_AUDIENCE: z.string().default('vendor'),

  API_RATE_LIMIT_DEFAULT: z.coerce.number().int().default(300),
  API_RATE_LIMIT_PAYMENT: z.coerce.number().int().default(30),

  // Swagger / OpenAPI UI at /docs (spec JSON at /docs-json). Enabled by default
  // outside production; set SWAGGER_ENABLED=true to expose it in production too.
  SWAGGER_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),

  // Slice 10a — integrations.
  // 32-byte key (base64/hex/utf8) for AES-256-GCM encryption of
  // TenantIntegrationCredential ciphertext. Dev default is NON-SECRET and must
  // be overridden in staging/prod (the app still boots without it in dev).
  INTEGRATION_ENC_KEY: z.string().default('dev-only-integration-key-change-me-32b!'),
  // Real provider base URLs. When unset, providers fall back to the clearly
  // labelled in-repo sandbox simulator (ADR-032). Go-live = set these + creds.
  OCR_API_URL: z.string().default(''),
  GSP_API_URL: z.string().default(''),
  // Slice 10b — banking. Unset → labelled sandbox simulator (no bank contract).
  BANK_API_URL: z.string().default(''),
  PENNY_DROP_API_URL: z.string().default(''),
  // Slice 10c — vendor verification. Unset → labelled sandbox simulator.
  SCREENING_API_URL: z.string().default(''),
  RECAPTCHA_SECRET: z.string().default(''), // unset → sandbox captcha stub
  RECAPTCHA_MIN_SCORE: z.coerce.number().default(0.5),
  // Shared secret the inbound-email provider (SendGrid/Mailgun) signs webhooks
  // with. Requests without it are rejected.
  EMAIL_INBOUND_WEBHOOK_SECRET: z.string().default('dev-email-inbound-secret'),

  // Slice 11c — observability (ADR-036). All optional: unset → the SDK no-ops, so
  // dev/test run with zero telemetry overhead. Set in staging/prod to export.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''), // e.g. Grafana Cloud OTLP URL
  OTEL_SERVICE_NAME: z.string().default('procureflow-api'),
  SENTRY_DSN: z.string().default(''), // unset → Sentry disabled
  DEPLOY_ENV: z.string().default('local'), // tags telemetry: local|dev|staging|prod
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = EnvSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Decode a base64-encoded PEM key from env into a usable PEM string. */
export function decodePem(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}
