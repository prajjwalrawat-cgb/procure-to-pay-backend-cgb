import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Mounts the OpenAPI (Swagger) UI at /docs and serves the raw spec at
 * /docs-json. The UI auto-discovers every controller route, HTTP verb and path
 * param. Request/response bodies are validated with Zod via ZodValidationPipe
 * (not class-validator decorators), so those schemas are not reflected into the
 * spec automatically — the endpoint list, methods and auth requirements are the
 * point here: a browsable map of the API you can also exercise with a token.
 *
 * Gated so it stays off in production unless SWAGGER_ENABLED=true.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('ProcureFlow API')
    .setDescription(
      'Procure-to-Pay backend API. All routes are served under the /api/v1 ' +
        'prefix (except /health). Click "Authorize" and paste an access token ' +
        'to try authenticated endpoints.',
    )
    .setVersion('1.0')
    // The API is served under a global prefix; point "try it out" at it.
    .addServer('/api/v1', 'Versioned API (default)')
    .addServer('/', 'Root (health check only)')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Paste an access token (without the "Bearer " prefix).',
      },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('docs', app, document, {
    // Keep the auth token across page reloads while exploring.
    swaggerOptions: { persistAuthorization: true },
    jsonDocumentUrl: 'docs-json',
    customSiteTitle: 'ProcureFlow API Docs',
  });
}
