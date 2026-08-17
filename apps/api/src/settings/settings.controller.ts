import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  BranchInputSchema,
  CustomFieldCreateInputSchema,
  CustomFieldEntitySchema,
  CustomFieldUpdateInputSchema,
  OrganisationUpdateInputSchema,
  PERMISSIONS,
  type Branch,
  type BranchInput,
  type CustomFieldCreateInput,
  type CustomFieldDefinition,
  type CustomFieldEntity,
  type CustomFieldUpdateInput,
  type OrganisationSettings,
  type OrganisationUpdateInput,
} from '@procureflow/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  assertUploadSize,
  DOCUMENT_UPLOAD_OPTIONS,
} from '../common/upload/upload-options';
import { CustomFieldsService } from './custom-fields.service';
import { SettingsService } from './settings.service';

/**
 * Organisation settings. Tenant identity, GST registrations and admin-defined
 * document fields are administered here instead of being fixed in code, so the
 * letterhead, place of supply and forms follow whichever organisation is
 * signed in.
 */
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly customFields: CustomFieldsService,
  ) {}

  @Get('organisation')
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  async get(@CurrentUser() user: AuthUser): Promise<OrganisationSettings> {
    return this.settings.get(user.tenantId);
  }

  @Patch('organisation')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  async update(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(OrganisationUpdateInputSchema))
    dto: OrganisationUpdateInput,
  ): Promise<OrganisationSettings> {
    return this.settings.update(user.tenantId, dto, user.userId);
  }

  // ── GST registrations (branches) ─────────────────────────────────────────

  @Get('branches')
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  async branches(@CurrentUser() user: AuthUser): Promise<Branch[]> {
    return this.settings.listBranches(user.tenantId);
  }

  @Post('branches')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  async createBranch(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(BranchInputSchema)) dto: BranchInput,
  ): Promise<Branch[]> {
    return this.settings.createBranch(user.tenantId, dto, user.userId);
  }

  @Put('branches/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  async updateBranch(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(BranchInputSchema)) dto: BranchInput,
  ): Promise<Branch[]> {
    return this.settings.updateBranch(user.tenantId, id, dto, user.userId);
  }

  @Post('branches/:id/default')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  async setDefaultBranch(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<Branch[]> {
    return this.settings.setDefaultBranch(user.tenantId, id, user.userId);
  }

  // ── Custom fields ────────────────────────────────────────────────────────

  /** Every definition in the tenant — the admin screen groups them itself. */
  @Get('custom-fields')
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  async listCustomFields(
    @CurrentUser() user: AuthUser,
    @Query('entityType') entityType?: string,
  ): Promise<CustomFieldDefinition[]> {
    if (!entityType) return this.customFields.listAll(user.tenantId);
    const parsed = CustomFieldEntitySchema.safeParse(entityType);
    if (!parsed.success) throw new BadRequestException('Unknown entity type');
    return this.customFields.list(user.tenantId, parsed.data, { includeInactive: true });
  }

  @Post('custom-fields')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  async createCustomField(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CustomFieldCreateInputSchema))
    dto: CustomFieldCreateInput,
  ): Promise<CustomFieldDefinition> {
    return this.customFields.create(user.tenantId, dto, user.userId);
  }

  @Patch('custom-fields/:id')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  async updateCustomField(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CustomFieldUpdateInputSchema))
    dto: CustomFieldUpdateInput,
  ): Promise<CustomFieldDefinition> {
    return this.customFields.update(user.tenantId, id, dto, user.userId);
  }

  /**
   * Definitions a form should render. Open to any signed-in user — a requester
   * filling in a requisition needs the field list without holding settings
   * permissions.
   */
  @Get('custom-fields/for/:entityType')
  async formFields(
    @CurrentUser() user: AuthUser,
    @Param('entityType') entityType: string,
  ): Promise<CustomFieldDefinition[]> {
    const parsed = CustomFieldEntitySchema.safeParse(entityType);
    if (!parsed.success) throw new BadRequestException('Unknown entity type');
    return this.customFields.list(user.tenantId, parsed.data as CustomFieldEntity);
  }

  // ── Branding ─────────────────────────────────────────────────────────────

  /** Letterhead logo — printed at the top of the PO PDF. */
  @Post('organisation/logo')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @UseInterceptors(FileInterceptor('file', DOCUMENT_UPLOAD_OPTIONS))
  async uploadLogo(
    @CurrentUser() user: AuthUser,
    @UploadedFile()
    file: { buffer: Buffer; mimetype: string; size?: number } | undefined,
  ): Promise<OrganisationSettings> {
    assertUploadSize(file);
    if (!file?.buffer) throw new BadRequestException('No file was uploaded.');
    return this.settings.setLogo(user.tenantId, file, user.userId);
  }
}
