import { Body, Controller, Delete, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthUser } from '../../auth/auth.types';
import { CurrentUser, Public } from '../../auth/decorators';
import { AskmiraService } from './askmira.service';

type RawRequest = Request & { rawBody?: Buffer };

/**
 * /api/v1/integrations/askmira/* — the AskMira link (askmira.service.ts).
 *
 * The server-to-server routes are @Public: they carry AskMira's own signed
 * token, checked against the raw body. `connection` and `connect/approve` are
 * an admin's browser here, behind the normal session.
 */
@ApiExcludeController()
@Controller('integrations/askmira')
export class AskmiraController {
  constructor(private readonly askmira: AskmiraService) {}

  @Public()
  @Post('users/sync')
  @HttpCode(200)
  async sync(@Req() req: RawRequest) {
    const { found, body } = await this.askmira.assertion(req.rawBody, req.headers.authorization, 'provision');
    return this.askmira.syncPeople(found, body);
  }

  @Public()
  @Post('query')
  @HttpCode(200)
  async query(@Req() req: RawRequest) {
    const { found, body } = await this.askmira.assertion(req.rawBody, req.headers.authorization, 'query');
    const me = await this.askmira.actorIn(found, body.actor);
    return this.askmira.query(found, me, String(body.kind ?? ''), paramsOf(body));
  }

  @Public()
  @Post('act')
  @HttpCode(200)
  async act(@Req() req: RawRequest) {
    const { found, body, claims } = await this.askmira.assertion(
      req.rawBody,
      req.headers.authorization,
      'act',
    );
    await this.askmira.spendOnce(claims, 'This request was already carried out.');
    const me = await this.askmira.actorIn(found, body.actor);
    return this.askmira.act(found, me, String(body.kind ?? ''), paramsOf(body));
  }

  @Public()
  @Post('connect/token')
  @HttpCode(200)
  async token(@Body() body: Record<string, unknown>) {
    return this.askmira.swap(body ?? {});
  }

  @Public()
  @Post('connect/revoke')
  @HttpCode(200)
  async revoke(@Req() req: RawRequest) {
    const { found } = await this.askmira.assertion(req.rawBody, req.headers.authorization, 'revoke');
    return this.askmira.revoke(found);
  }

  @Public()
  @Post('launch')
  @HttpCode(200)
  async launch(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const token = String(body?.token ?? '');
    return this.askmira.launch(token.length > 4000 ? '' : token, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
  }

  @Get('connection')
  async connection(@CurrentUser() user: AuthUser) {
    return this.askmira.connection(user);
  }

  @Delete('connection')
  async disconnect(@CurrentUser() user: AuthUser) {
    return this.askmira.disconnect(user);
  }

  @Post('connect/approve')
  @HttpCode(200)
  async approve(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.askmira.approve(user, body ?? {});
  }
}

function paramsOf(body: Record<string, unknown>): Record<string, unknown> {
  const params = body.params;
  return params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}
