// Must be first: starts OpenTelemetry auto-instrumentation + Sentry (both
// env-gated, no-op when unconfigured) before any instrumented module loads.
import './observability/instrumentation';
import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import type { Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService<Env, true>);

  // /health stays off the versioned prefix for the load balancer (§10).
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  app.enableCors({
    origin: config.get('API_CORS_ORIGINS', { infer: true }).split(','),
    credentials: true,
  });

  // Railway (and most PaaS) inject a dynamic $PORT the service must bind; fall
  // back to API_PORT for local/dev. Bind 0.0.0.0 so the container is reachable.
  const port = process.env.PORT ? Number(process.env.PORT) : config.get('API_PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
  app.get(Logger).log(`ProcureFlow API listening on :${port}`);
}

void bootstrap();
