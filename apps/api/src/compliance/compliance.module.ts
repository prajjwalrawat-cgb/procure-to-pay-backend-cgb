import { Module } from '@nestjs/common';

import { ComplianceController } from './compliance.controller';
import { EwayBillValidationService } from './eway-validation.service';
import { Gstr2bReconciliationService } from './gstr2b-reconcile.service';
import { IrnValidationService } from './irn-validation.service';

/**
 * Compliance module (Slice 10a). GSP-mediated GST integrations: nightly GSTR-2B
 * reconciliation, IRN validation, and live e-Way bill checks. Depends only on the
 * global IntegrationsModule (GspClient) + global infra; exports the e-Way service
 * so the GRN module can run a live validity check at receipt time.
 */
@Module({
  controllers: [ComplianceController],
  providers: [
    Gstr2bReconciliationService,
    IrnValidationService,
    EwayBillValidationService,
  ],
  exports: [EwayBillValidationService, IrnValidationService, Gstr2bReconciliationService],
})
export class ComplianceModule {}
