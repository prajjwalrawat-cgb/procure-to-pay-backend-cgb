import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  BoxCreateInputSchema,
  BoxListQuerySchema,
  BoxMoveInputSchema,
  BoxPackInputSchema,
  BoxUnpackInputSchema,
  PERMISSIONS,
  type BoxCreateInput,
  type BoxDetailResponse,
  type BoxListItem,
  type BoxListQuery,
  type BoxMoveInput,
  type BoxMoveResponse,
  type BoxPackInput,
  type ProductWhereResponse,
} from '@procureflow/shared';

import type { AuthUser } from '../../auth/auth.types';
import { CurrentUser, RequirePermission } from '../../auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BoxMovementService } from './box-movement.service';
import { BoxService } from './box.service';

/**
 * BoxController (Slice 14) — physical box tracking.
 *
 * Permissions follow the same rule as the scanner: the authority matches the
 * action, not the device. Looking a box up is a read; filling, emptying and
 * moving one are floor operations on `inventory:scan`; registering a box is
 * catalogue work on `inventory:product_manage`, because a box is a piece of
 * warehouse master data like a location is.
 */
@Controller('boxes')
export class BoxController {
  constructor(
    private readonly boxes: BoxService,
    private readonly movement: BoxMovementService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async list(
    @Query(new ZodValidationPipe(BoxListQuerySchema)) q: BoxListQuery,
  ): Promise<{ items: BoxListItem[] }> {
    return this.boxes.list(q);
  }

  @Post()
  @RequirePermission(PERMISSIONS.INVENTORY_PRODUCT_MANAGE)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(BoxCreateInputSchema)) dto: BoxCreateInput,
  ): Promise<BoxDetailResponse> {
    return this.boxes.create(dto, user.userId);
  }

  /**
   * Scan a box label → what it is, where it is, and everything inside it.
   * The single most-used endpoint in this module: it is what happens when
   * somebody points a phone at a carton.
   */
  @Get('by-barcode/:barcode')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async byBarcode(@Param('barcode') barcode: string): Promise<BoxDetailResponse> {
    const { id } = await this.boxes.resolveByBarcode(barcode);
    return this.boxes.detail(id);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async detail(@Param('id') id: string): Promise<BoxDetailResponse> {
    return this.boxes.detail(id);
  }

  /** Move loose stock at a location into a box standing there. */
  @Post('pack')
  @RequirePermission(PERMISSIONS.INVENTORY_SCAN)
  async pack(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(BoxPackInputSchema)) dto: BoxPackInput,
  ): Promise<BoxMoveResponse> {
    return this.movement.pack(dto, user.userId);
  }

  /** Take stock out of a box, leaving it loose at the same location. */
  @Post('unpack')
  @RequirePermission(PERMISSIONS.INVENTORY_SCAN)
  async unpack(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(BoxUnpackInputSchema)) dto: BoxPackInput,
  ): Promise<BoxMoveResponse> {
    return this.movement.unpack(dto, user.userId);
  }

  /** Move a box, and everything in it, to another section. */
  @Post('move')
  @RequirePermission(PERMISSIONS.INVENTORY_SCAN)
  async move(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(BoxMoveInputSchema)) dto: BoxMoveInput,
  ): Promise<BoxMoveResponse> {
    return this.movement.move(dto, user.userId);
  }
}

/**
 * The reverse lookup lives under the product it answers for, rather than under
 * /boxes: the question is "where is this product", and the answer includes
 * loose stock that is in no box at all.
 */
@Controller('inventory/products')
export class ProductLocationController {
  constructor(private readonly boxes: BoxService) {}

  @Get(':id/where')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async whereIs(@Param('id') id: string): Promise<ProductWhereResponse> {
    return this.boxes.whereIs(id);
  }
}
