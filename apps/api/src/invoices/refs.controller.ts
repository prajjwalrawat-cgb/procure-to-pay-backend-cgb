import { Controller, Get, Param } from '@nestjs/common';

import { RefsService, type RefCard } from './refs.service';

/** Lazy hover-preview cards for referenced entities (buyer portal). */
@Controller('refs')
export class RefsController {
  constructor(private readonly refs: RefsService) {}

  @Get(':kind/:id')
  async card(@Param('kind') kind: string, @Param('id') id: string): Promise<RefCard> {
    return this.refs.card(kind, id);
  }
}
