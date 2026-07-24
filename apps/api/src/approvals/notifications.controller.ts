import { Controller, Get, Param, Post } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { NotificationService, type NotificationView } from './notification.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<NotificationView[]> {
    return this.notifications.listFor(user.userId);
  }

  @Get('unread-count')
  async unread(@CurrentUser() user: AuthUser): Promise<{ count: number }> {
    return { count: await this.notifications.unreadCount(user.userId) };
  }

  @Post(':id/read')
  async read(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.notifications.markRead(user.userId, id);
    return { ok: true };
  }
}
