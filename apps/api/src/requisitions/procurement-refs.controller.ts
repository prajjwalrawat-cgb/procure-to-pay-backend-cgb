import { Controller, Get } from '@nestjs/common';
import {
  PERMISSIONS,
  type CostCenterRef,
  type PlantRef,
  type VendorRef,
} from '@procureflow/shared';

import { RequirePermission } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Lightweight reference lists for the PR/PO wizard pickers (Slice 4). Returns
 * real tenant-scoped IDs so the frontend never has to guess ULIDs. Gated on the
 * broad procurement-read permission (requesters + procurement all have it).
 */
@Controller()
export class ProcurementRefsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('cost-centers')
  @RequirePermission(PERMISSIONS.BUDGET_READ)
  async costCenters(): Promise<{ items: CostCenterRef[] }> {
    const rows = await this.prisma.client.costCenter.findMany({
      orderBy: { code: 'asc' },
    });
    return {
      items: rows.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        deptId: c.deptId,
        plantId: c.plantId,
      })),
    };
  }

  @Get('plants')
  @RequirePermission(PERMISSIONS.BUDGET_READ)
  /** Branches = GST registrations. The tenant's default sorts first so a form
   *  defaulting to the first entry picks the intended registration, not
   *  whichever branch happens to sort first alphabetically. */
  async plants(): Promise<{ items: PlantRef[] }> {
    const rows = await this.prisma.client.plant.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return {
      items: rows.map((p) => ({
        id: p.id,
        name: p.name,
        stateCode: p.stateCode,
        address: p.address,
        gstin: p.gstin,
        isDefault: p.isDefault,
      })),
    };
  }

  // Namespaced under /refs to leave the canonical /vendors resource to the
  // Slice 7 vendor-master controller (VendorsController). This is a lightweight
  // active-vendor picker for the PR/PO forms, not the vendor master.
  @Get('refs/vendors')
  @RequirePermission(PERMISSIONS.PURCHASE_ORDER_READ_TENANT)
  async vendors(): Promise<{ items: VendorRef[] }> {
    const rows = await this.prisma.client.vendor.findMany({
      // Gate on lifecycle_status, the same field `requireEligibleVendor` uses at
      // submit time. The legacy `status` can drift from it — a vendor put back
      // under review keeps status ACTIVE — and picking one of those let a buyer
      // build an entire PO that could never be submitted.
      where: { lifecycleStatus: 'ACTIVE' },
      orderBy: { name: 'asc' },
      include: { banks: true },
    });
    return {
      items: rows.map((v) => ({
        id: v.id,
        code: v.code,
        name: v.name,
        isMsme: v.isMsme,
        status: v.status,
        bankVerified: v.banks.some((b) => b.isVerified),
      })),
    };
  }
}
