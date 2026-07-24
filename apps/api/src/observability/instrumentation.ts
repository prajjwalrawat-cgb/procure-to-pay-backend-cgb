/**
 * Observability bootstrap (Slice 11c · ADR-036).
 *
 * MUST be imported before any other application module so OpenTelemetry's
 * auto-instrumentation can patch http/pg/ioredis/nestjs at require-time. main.ts
 * imports this file first.
 *
 * Everything here is **env-gated and no-ops when unconfigured**: with no
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and no `SENTRY_DSN` (the dev/test default) the
 * process starts with zero telemetry overhead and no external connections. Set
 * the env vars in staging/prod to export traces to Grafana Cloud (OTLP) and
 * errors to Sentry. This keeps the wiring real and production-ready without
 * requiring a collector to be running locally.
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import * as Sentry from '@sentry/node';

// deployment.environment is an incubating semantic attribute; use the stable key string.
const ATTR_DEPLOYMENT_ENVIRONMENT = 'deployment.environment';

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
const sentryDsn = process.env.SENTRY_DSN ?? '';
const serviceName = process.env.OTEL_SERVICE_NAME ?? 'procureflow-api';
const deployEnv = process.env.DEPLOY_ENV ?? 'local';

let sdk: NodeSDK | undefined;

if (otlpEndpoint) {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_DEPLOYMENT_ENVIRONMENT]: deployEnv,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
    // pg + ioredis + http + nestjs spans out of the box; fs is noisy, so off.
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
  // eslint-disable-next-line no-console
  console.log(
    `[otel] tracing → ${otlpEndpoint} (service=${serviceName}, env=${deployEnv})`,
  );
}

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: deployEnv,
    tracesSampleRate: deployEnv === 'prod' ? 0.1 : 1.0,
  });
  // eslint-disable-next-line no-console
  console.log(`[sentry] error tracking enabled (env=${deployEnv})`);
}

// Flush both exporters on shutdown so the last spans/errors are not lost.
async function shutdownObservability(): Promise<void> {
  await Promise.allSettled([sdk?.shutdown(), sentryDsn ? Sentry.close(2000) : undefined]);
}
process.on('SIGTERM', () => {
  void shutdownObservability();
});

export { Sentry, shutdownObservability };
