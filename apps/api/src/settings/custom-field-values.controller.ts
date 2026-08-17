import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common';
import {
  CustomFieldEntitySchema,
  CustomFieldValuesSchema,
  type CustomFieldEntity,
  type CustomFieldValues,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { CustomFieldsService } from './custom-fields.service';

/**
 * Captured values for admin-defined fields.
 *
 * One generic route per document type rather than six bespoke ones: the field
 * list is tenant data, so the write path is the same shape whatever the
 * document is. Values are validated against the tenant's definitions and
 * written to that document's own `custom_fields` column.
 *
 * Deliberately not permission-gated on `settings:*` — a requester filling in a
 * requisition captures these fields, and only an admin defines them. Access to
 * the document itself is enforced by tenant scoping: RLS already confines the
 * update to the caller's tenant, and a row from another tenant reads back as
 * not found.
 */
@Controller('custom-fields/values')
export class CustomFieldValuesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customFields: CustomFieldsService,
  ) {}

  @Get(':entityType/:id')
  async read(
    @CurrentUser() user: AuthUser,
    @Param('entityType') entityType: string,
    @Param('id') id: string,
  ): Promise<{ values: CustomFieldValues }> {
    const entity = parseEntity(entityType);
    const row = await this.findRow(user.tenantId, entity, id);
    return { values: (row.customFields as CustomFieldValues | null) ?? {} };
  }

  @Put(':entityType/:id')
  async write(
    @CurrentUser() user: AuthUser,
    @Param('entityType') entityType: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CustomFieldValuesSchema)) body: CustomFieldValues,
  ): Promise<{ values: CustomFieldValues }> {
    const entity = parseEntity(entityType);
    await this.findRow(user.tenantId, entity, id);
    const clean = await this.customFields.validate(user.tenantId, entity, body);
    await this.delegate(entity).update({ where: { id }, data: { customFields: clean } });
    return { values: clean ?? {} };
  }

  private async findRow(
    tenantId: string,
    entity: CustomFieldEntity,
    id: string,
  ): Promise<{ customFields: unknown }> {
    const row = (await this.delegate(entity).findFirst({
      where: { id, tenantId },
      select: { customFields: true },
    })) as { customFields: unknown } | null;
    if (!row) throw new NotFoundException('Document not found');
    return row;
  }

  /**
   * The Prisma delegate for a document type. Typed loosely on purpose: the six
   * delegates have different generics but identical shape for the two calls
   * used here, and a discriminated union of all six would be far more code than
   * the safety is worth given `entity` is already validated against a fixed
   * enum.
   */
  private delegate(entity: CustomFieldEntity): {
    findFirst: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  } {
    const client = this.prisma.client as unknown as Record<
      string,
      {
        findFirst: (args: unknown) => Promise<unknown>;
        update: (args: unknown) => Promise<unknown>;
      }
    >;
    const byEntity: Record<CustomFieldEntity, string> = {
      REQUISITION: 'requisition',
      PURCHASE_ORDER: 'purchaseOrder',
      GOODS_RECEIPT: 'goodsReceiptNote',
      INVOICE: 'invoice',
      VENDOR: 'vendor',
      ITEM: 'item',
    };
    const delegate = client[byEntity[entity]];
    if (!delegate) throw new BadRequestException('Unsupported document type');
    return delegate;
  }
}

function parseEntity(value: string): CustomFieldEntity {
  const parsed = CustomFieldEntitySchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Unknown document type');
  return parsed.data;
}
