import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ItemCreateInputSchema,
  ItemListQuerySchema,
  ItemUpdateInputSchema,
  PERMISSIONS,
  type ItemCreateInput,
  type ItemDetailResponse,
  type ItemListQuery,
  type ItemListResponse,
  type ItemUpdateInput,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ItemService } from './item.service';

@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ITEM_READ)
  async list(
    @Query(new ZodValidationPipe(ItemListQuerySchema)) q: ItemListQuery,
  ): Promise<ItemListResponse> {
    return this.items.search(q);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.ITEM_READ)
  async detail(@Param('id') id: string): Promise<ItemDetailResponse> {
    return this.items.getWithVendorPricing(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.ITEM_CREATE)
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ItemCreateInputSchema)) dto: ItemCreateInput,
  ): Promise<{ id: string }> {
    return this.items.create(dto, user.userId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.ITEM_UPDATE)
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ItemUpdateInputSchema)) dto: ItemUpdateInput,
  ): Promise<{ ok: true }> {
    return this.items.update(id, dto, user.userId);
  }

  @Post(':id/deactivate')
  @RequirePermission(PERMISSIONS.ITEM_UPDATE)
  async deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.items.deactivate(id, user.userId);
  }
}
