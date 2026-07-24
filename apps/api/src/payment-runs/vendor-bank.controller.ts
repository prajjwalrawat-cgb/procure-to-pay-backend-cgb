import { Controller, Param, Post } from '@nestjs/common';
import { PERMISSIONS } from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import {
  VendorBankVerificationService,
  type PennyDropResult,
} from './vendor-bank-verification.service';

@Controller('vendor-banks')
export class VendorBankController {
  constructor(private readonly verification: VendorBankVerificationService) {}

  /** Penny-drop verify a vendor bank (mocked in Slice 3). */
  @Post(':id/verify')
  @RequirePermission(PERMISSIONS.PAYMENT_RUN_COMPOSE)
  async verify(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<PennyDropResult> {
    return this.verification.pennyDrop(id, user.userId);
  }
}
