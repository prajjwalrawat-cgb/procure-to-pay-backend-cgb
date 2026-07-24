import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProblemExceptionFilter } from '../common/filters/problem.filter';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionGuard } from './guards/permission.guard';

/**
 * Integration test: AuthController wired through Nest with a mocked service and
 * the real ZodValidationPipe + ProblemExceptionFilter. No DB/infra needed.
 */
describe('AuthController (integration)', () => {
  let app: INestApplication;
  const login = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: { login, refresh: vi.fn(), logout: vi.fn() } },
        { provide: APP_FILTER, useClass: ProblemExceptionFilter },
      ],
    })
      // Public routes anyway, but override to be explicit and hermetic.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 and tokens for a valid login body', async () => {
    login.mockResolvedValueOnce({
      user: { id: 'usr_1', email: 'a@b.com', name: 'A', roles: [], mfaEnabled: false },
      tokens: {
        accessToken: 't',
        refreshToken: 'r',
        tokenType: 'Bearer',
        expiresIn: 900,
      },
    });

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .set('x-portal', 'buyer')
      .send({ email: 'a@b.com', password: 'Slice0!Demo' });

    expect(res.status).toBe(201);
    expect(res.body.tokens.accessToken).toBe('t');
    expect(login).toHaveBeenCalledOnce();
  });

  it('rejects an invalid body as RFC 7807 problem+json (422)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.type).toContain('/errors/validation');
  });
});
