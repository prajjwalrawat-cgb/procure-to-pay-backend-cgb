import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CycleCountScanInputSchema,
  CycleCountStartInputSchema,
  PERMISSIONS,
  PickListCreateInputSchema,
  ScanBatchSyncInputSchema,
  ScanPickInputSchema,
  ScanPutawayInputSchema,
  ScanReceiveInputSchema,
  ScanResolveInputSchema,
  ScanTransferInputSchema,
  type BatchSyncResponse,
  type CycleCountScanInput,
  type CycleCountSessionResponse,
  type CycleCountStartInput,
  type PickListCreateInput,
  type PickListResponse,
  type ScanBatchSyncInput,
  type ScanPickInput,
  type ScanPickResponse,
  type ScanPutawayInput,
  type ScanPutawayResponse,
  type ScanReceiveInput,
  type ScanReceiveResponse,
  type ScanResolveInput,
  type ScanResolveResponse,
  type ScanTransferInput,
  type ScanTransferResponse,
} from '@procureflow/shared';

import type { AuthUser } from '../../auth/auth.types';
import { CurrentUser, RequirePermission } from '../../auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ScanBatchSyncService } from './scan-batch-sync.service';
import { ScanCycleCountService } from './scan-cycle-count.service';
import { ScanPickService } from './scan-pick.service';
import { ScanPutawayService } from './scan-putaway.service';
import { ScanReceiveService } from './scan-receive.service';
import { ScanResolveService } from './scan-resolve.service';
import { ScanTransferService } from './scan-transfer.service';

/**
 * ScanController (Slice 13) — the mobile scanner API.
 *
 * Permissions follow the *action*, not the device. Scanning a receipt still
 * requires `stores:receive_goods`, picking still requires `inventory:fulfill`,
 * and approving a count variance — the one scanner action that moves stock with
 * no physical movement behind it — still requires `inventory:adjust`. Only the
 * operations that exist solely because there is now a scanner (putaway, bin
 * transfer, running a count) sit on the new `inventory:scan` permission.
 */
@Controller('scan')
export class ScanController {
  constructor(
    private readonly resolve: ScanResolveService,
    private readonly receives: ScanReceiveService,
    private readonly putaways: ScanPutawayService,
    private readonly picks: ScanPickService,
    private readonly counts: ScanCycleCountService,
    private readonly transfers: ScanTransferService,
    private readonly sync: ScanBatchSyncService,
  ) {}

  // ══════════════════════ Resolve ══════════════════════

  /**
   * Barcode → product. Rate-limited well below the global ceiling: a camera in
   * continuous-decode mode will happily fire this dozens of times a second at a
   * barcode it cannot read, and that is a client bug, not a workload.
   */
  @Post('resolve')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async resolveBarcode(
    @Body(new ZodValidationPipe(ScanResolveInputSchema)) dto: ScanResolveInput,
  ): Promise<ScanResolveResponse> {
    return this.resolve.resolveView(dto.barcodeRaw);
  }

  // ══════════════════════ Receive ══════════════════════

  @Post('receive')
  @RequirePermission(PERMISSIONS.STORES_RECEIVE_GOODS)
  async receive(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ScanReceiveInputSchema)) dto: ScanReceiveInput,
  ): Promise<ScanReceiveResponse> {
    return this.receives.receive(dto, user.userId);
  }

  // ══════════════════════ Putaway ══════════════════════

  @Post('putaway')
  @RequirePermission(PERMISSIONS.INVENTORY_SCAN)
  async putaway(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ScanPutawayInputSchema)) dto: ScanPutawayInput,
  ): Promise<ScanPutawayResponse> {
    return this.putaways.putaway(dto, user.userId);
  }

  // ══════════════════════ Pick ══════════════════════

  @Post('pick')
  @RequirePermission(PERMISSIONS.INVENTORY_FULFILL)
  async pick(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ScanPickInputSchema)) dto: ScanPickInput,
  ): Promise<ScanPickResponse> {
    return this.picks.pick(dto, user.userId);
  }

  /** The live pick checklist for one order. */
  @Get('pick/:orderId')
  @RequirePermission(PERMISSIONS.INVENTORY_FULFILL)
  async pickList(@Param('orderId') orderId: string): Promise<PickListResponse> {
    return this.picks.pickList(orderId);
  }

  /** Create the pick list the scanner picks against. */
  @Post('pick-lists')
  @RequirePermission(PERMISSIONS.INVENTORY_FULFILL)
  async createPickList(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(PickListCreateInputSchema)) dto: PickListCreateInput,
  ): Promise<PickListResponse> {
    return this.picks.createPickList(dto, user.userId);
  }

  // ══════════════════════ Cycle count ══════════════════════

  @Post('cycle-count/start')
  @RequirePermission(PERMISSIONS.INVENTORY_SCAN)
  async startCount(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CycleCountStartInputSchema)) dto: CycleCountStartInput,
  ): Promise<CycleCountSessionResponse> {
    return this.counts.start(dto, user.userId);
  }

  @Post('cycle-count/:sessionId/scan')
  @RequirePermission(PERMISSIONS.INVENTORY_SCAN)
  async countScan(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(CycleCountScanInputSchema)) dto: CycleCountScanInput,
  ): Promise<CycleCountSessionResponse> {
    return this.counts.scan(sessionId, dto, user.userId);
  }

  @Post('cycle-count/:sessionId/complete')
  @RequirePermission(PERMISSIONS.INVENTORY_SCAN)
  async completeCount(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
  ): Promise<CycleCountSessionResponse> {
    return this.counts.complete(sessionId, user.userId);
  }

  /**
   * The approval gate. `inventory:adjust` is the module's existing authority for
   * corrections — the people who may write off damage are the people who may
   * accept a count variance. Counters do not hold it.
   */
  @Post('cycle-count/:sessionId/approve')
  @RequirePermission(PERMISSIONS.INVENTORY_ADJUST)
  async approveCount(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
  ): Promise<CycleCountSessionResponse> {
    return this.counts.approve(sessionId, user.userId);
  }

  @Get('cycle-count/:sessionId')
  @RequirePermission(PERMISSIONS.INVENTORY_SCAN)
  async countSession(
    @Param('sessionId') sessionId: string,
  ): Promise<CycleCountSessionResponse> {
    return this.counts.view(sessionId);
  }

  // ══════════════════════ Transfer ══════════════════════

  @Post('transfer')
  @RequirePermission(PERMISSIONS.INVENTORY_SCAN)
  async transfer(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ScanTransferInputSchema)) dto: ScanTransferInput,
  ): Promise<ScanTransferResponse> {
    return this.transfers.transfer(dto, user.userId);
  }

  // ══════════════════════ Offline batch sync ══════════════════════

  /**
   * Drains the handset's offline queue. Every scan type routes to the same
   * service the live endpoint uses, so a queued scan is validated and authorised
   * exactly as an online one would be.
   *
   * Note the permission model: `inventory:scan` only admits the caller to the
   * endpoint. Because one guard here stands in for five differently-privileged
   * operations, the service re-checks each item against the caller's own
   * permissions — a user who cannot receive goods cannot smuggle a receipt
   * through the queue.
   */
  @Post('batch-sync')
  @RequirePermission(PERMISSIONS.INVENTORY_SCAN)
  async batchSync(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ScanBatchSyncInputSchema)) dto: ScanBatchSyncInput,
  ): Promise<BatchSyncResponse> {
    return this.sync.sync(dto, user.userId, user.tenantId, user.perms);
  }
}
