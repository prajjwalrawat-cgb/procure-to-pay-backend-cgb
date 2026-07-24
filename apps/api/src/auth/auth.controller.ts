import { Body, Controller, Headers, Ip, Post, Req } from '@nestjs/common';
import {
  LoginInputSchema,
  MfaVerifyInputSchema,
  PortalSchema,
  RefreshInputSchema,
  type LoginInput,
  type LoginResponse,
  type MfaVerifyInput,
  type Portal,
  type RefreshInput,
} from '@procureflow/shared';
import type { Request } from 'express';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import type { AuthUser } from './auth.types';
import { CurrentUser, Public } from './decorators';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  async login(
    @Body(new ZodValidationPipe(LoginInputSchema)) dto: LoginInput,
    @Headers('x-portal') portalHeader: string | undefined,
    @Ip() ip: string,
    @Req() req: Request,
  ): Promise<LoginResponse> {
    const portal: Portal = PortalSchema.catch('buyer').parse(portalHeader);
    return this.auth.login(dto, portal, {
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Body(new ZodValidationPipe(RefreshInputSchema)) dto: RefreshInput,
  ): Promise<LoginResponse['tokens']> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  async logout(
    @Body(new ZodValidationPipe(RefreshInputSchema)) dto: RefreshInput,
  ): Promise<{ ok: true }> {
    await this.auth.logout(dto.refreshToken);
    return { ok: true };
  }

  @Post('mfa/setup')
  async mfaSetup(
    @CurrentUser() user: AuthUser,
  ): Promise<{ provisioningUri: string; qrSvg: string }> {
    // Email is not on the token; otplib's label uses the user id (the subject).
    return this.auth.setupMfa(user.userId, user.tenantId, user.userId);
  }

  @Post('mfa/verify')
  async mfaVerify(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(MfaVerifyInputSchema)) dto: MfaVerifyInput,
  ): Promise<{ ok: true }> {
    await this.auth.verifyMfa(user.userId, user.tenantId, dto.code);
    return { ok: true };
  }
}
