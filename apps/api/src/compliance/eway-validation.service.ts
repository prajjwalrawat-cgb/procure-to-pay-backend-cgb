import { Injectable } from '@nestjs/common';

import { GspClient } from '../integrations/gsp/gsp-client';

/**
 * EwayBillValidationService (Slice 10a). Replaces Slice 5's stored-date-only
 * "warn if expired" with a live validity check against NIC's e-Way Bill system
 * (GSP-mediated; simulator until a contract lands). Non-blocking: a failed check
 * or provider outage surfaces a flag for review, never blocks GRN creation.
 */
@Injectable()
export class EwayBillValidationService {
  constructor(private readonly gsp: GspClient) {}

  /**
   * @returns `null` when the bill is valid (or the check couldn't run); a flag
   *          string when the live check says the bill is invalid/expired.
   */
  async checkForGrn(
    ewbNo: string | null | undefined,
    tenantId: string,
  ): Promise<string | null> {
    if (!ewbNo) return null;
    try {
      const { valid } = await this.gsp.checkEwayValidity(ewbNo, tenantId);
      return valid ? null : 'EWAY_BILL_INVALID';
    } catch {
      // Provider degraded — don't block goods receipt; leave stored-date warning.
      return null;
    }
  }
}
