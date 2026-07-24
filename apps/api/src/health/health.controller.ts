import { Controller, Get, Header, HttpCode } from '@nestjs/common';

import { Public } from '../auth/decorators';
import { HealthService, type HealthReport } from './health.service';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get('health')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async check(): Promise<HealthReport> {
    return this.health.check();
  }
}
