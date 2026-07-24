import { Injectable } from '@nestjs/common';
import { newId } from '@procureflow/db';

import { PrismaService } from '../prisma/prisma.service';

export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  href?: string | null;
  tenantId?: string;
}

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  href: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * Minimal in-app notifications (Slice 2). Writes rows only; email/SMS delivery
 * lands in Slice 10. The tray + inbox render straight from this table.
 */
@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async notify(input: NotifyInput): Promise<void> {
    const tenantId = input.tenantId ?? this.prisma.currentTenantId;
    if (!tenantId)
      throw new Error('NotificationService.notify requires a tenant context.');
    await this.prisma.client.notification.create({
      data: {
        id: newId('notification'),
        tenantId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        href: input.href ?? null,
      },
    });
  }

  async listFor(userId: string, limit = 30): Promise<NotificationView[]> {
    const rows = await this.prisma.client.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
    return rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      href: n.href,
      entityType: n.entityType,
      entityId: n.entityId,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    }));
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.prisma.client.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.client.notification.count({ where: { userId, readAt: null } });
  }
}
