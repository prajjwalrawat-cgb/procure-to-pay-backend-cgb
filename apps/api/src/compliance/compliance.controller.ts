import { Controller, Param, Post } from '@nestjs/common';
import {
  PERMISSIONS,
  type Gstr2bReconResult,
  type IrnValidationResult,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { Gstr2bReconciliationService } from './gstr2b-reconcile.service';
import { IrnValidationService } from './irn-validation.service';

/** Compliance integrations — GSTR-2B reconciliation + IRN validation (Slice 10a). */
@Controller('compliance')
export class ComplianceController {
  constructor(
    private readonly gstr2b: Gstr2bReconciliationService,
    private readonly irn: IrnValidationService,
  ) {}

  /** Manually trigger GSTR-2B reconciliation for the caller's tenant only. */
  @Post('gstr2b/reconcile')
  @RequirePermission(PERMISSIONS.COMPLIANCE_RUN)
  async reconcile(@CurrentUser() user: AuthUser): Promise<Gstr2bReconResult> {
    return this.gstr2b.reconcileTenant(user.tenantId);
  }

  @Post('invoices/:id/validate-irn')
  @RequirePermission(PERMISSIONS.COMPLIANCE_RUN)
  async validateIrn(@Param('id') id: string): Promise<IrnValidationResult> {
    return this.irn.validateForInvoice(id);
  }
}
