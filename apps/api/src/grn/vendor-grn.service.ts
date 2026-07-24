import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { VendorGrnListResponse, VendorRmaListResponse } from '@procureflow/shared';

import { PrismaService } from '../prisma/prisma.service';
import { GrnQueryService } from './grn-query.service';
import { RmaQueryService } from './rma-query.service';
import { RmaService } from './rma.service';

/**
 * Vendor-portal GRN/RMA operations (Slice 5, vendor JWT audience). The vendor is
 * resolved from the logged-in user's contact record — never trusted from input
 * — so a vendor sees only their own deliveries and returns.
 */
@Injectable()
export class VendorGrnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grnQuery: GrnQueryService,
    private readonly rmaQuery: RmaQueryService,
    private readonly rma: RmaService,
  ) {}

  async resolveVendorId(userId: string): Promise<string> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new ForbiddenException('Not a vendor account');
    const contact = await this.prisma.client.vendorContact.findFirst({
      where: { email: user.email },
      select: { vendorId: true },
    });
    if (!contact) throw new ForbiddenException('No vendor linked to this account');
    return contact.vendorId;
  }

  async listGrns(userId: string): Promise<VendorGrnListResponse> {
    return this.grnQuery.listForVendor(await this.resolveVendorId(userId));
  }

  async listRmas(userId: string): Promise<VendorRmaListResponse> {
    return this.rmaQuery.listForVendor(await this.resolveVendorId(userId));
  }

  async schedulePickup(
    userId: string,
    rmaId: string,
    pickupAt: string,
  ): Promise<{ ok: true }> {
    await this.requireVendorRma(userId, rmaId);
    return this.rma.schedulePickup(rmaId, pickupAt, userId);
  }

  async rmaPdfId(userId: string, rmaId: string): Promise<string> {
    const rma = await this.requireVendorRma(userId, rmaId);
    if (!rma.pdfS3Key) throw new NotFoundException('No PDF available for this RMA.');
    return rma.id;
  }

  private async requireVendorRma(userId: string, rmaId: string) {
    const vendorId = await this.resolveVendorId(userId);
    const rma = await this.prisma.client.returnMaterialAuth.findUnique({
      where: { id: rmaId },
    });
    // Return 404 for another vendor's RMA — no existence disclosure.
    if (!rma || rma.vendorId !== vendorId || rma.status === 'DRAFT') {
      throw new NotFoundException('RMA not found');
    }
    return rma;
  }
}
