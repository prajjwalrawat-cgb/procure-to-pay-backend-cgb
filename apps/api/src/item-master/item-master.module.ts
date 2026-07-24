import { Module } from '@nestjs/common';

import { ItemService } from './item.service';
import { ItemsController } from './items.controller';

/** Item master (Slice 4). Backs PR line autocomplete + UOM conversion. */
@Module({
  controllers: [ItemsController],
  providers: [ItemService],
  exports: [ItemService],
})
export class ItemMasterModule {}
