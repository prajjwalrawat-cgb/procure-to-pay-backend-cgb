import { Controller, Get } from '@nestjs/common';

import type { AuthUser } from './auth.types';
import { CurrentUser, RequireAudience } from './decorators';

/**
 * Diagnostic endpoints proving the buyer/vendor JWT audience split
 * (Master Context §3 rule #11 / Slice 0 verification). A buyer token is
 * rejected by `/_audience/vendor` and vice versa, via JwtAuthGuard.
 */
@Controller('_audience')
export class AudienceController {
  @Get('buyer')
  @RequireAudience('buyer')
  buyerPing(@CurrentUser() user: AuthUser): { audience: string; tenantId: string } {
    return { audience: user.audience, tenantId: user.tenantId };
  }

  @Get('vendor')
  @RequireAudience('vendor')
  vendorPing(@CurrentUser() user: AuthUser): { audience: string; tenantId: string } {
    return { audience: user.audience, tenantId: user.tenantId };
  }
}
