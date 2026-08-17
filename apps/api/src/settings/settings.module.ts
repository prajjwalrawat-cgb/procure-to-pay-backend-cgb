import { Module } from '@nestjs/common';

import { StorageModule } from '../common/storage/storage.service';
import { CustomFieldValuesController } from './custom-field-values.controller';
import { CustomFieldsService } from './custom-fields.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/** Organisation settings (Slice 11) — tenant identity, GST registrations, the
 *  letterhead logo the PO PDF prints, and admin-defined document fields. */
@Module({
  imports: [StorageModule],
  controllers: [SettingsController, CustomFieldValuesController],
  providers: [SettingsService, CustomFieldsService],
  exports: [SettingsService, CustomFieldsService],
})
export class SettingsModule {}
