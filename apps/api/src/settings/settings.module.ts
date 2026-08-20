import { Module } from '@nestjs/common';

import { StorageModule } from '../common/storage/storage.service';
import { CustomFieldValuesController } from './custom-field-values.controller';
import { CustomFieldsService } from './custom-fields.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { VendorCategoriesService } from './vendor-categories.service';

/** Organisation settings (Slice 11) — tenant identity, GST registrations, the
 *  letterhead logo the PO PDF prints, admin-defined document fields and the
 *  tenant's own vendor categories. */
@Module({
  imports: [StorageModule],
  controllers: [SettingsController, CustomFieldValuesController],
  providers: [SettingsService, CustomFieldsService, VendorCategoriesService],
  exports: [SettingsService, CustomFieldsService, VendorCategoriesService],
})
export class SettingsModule {}
