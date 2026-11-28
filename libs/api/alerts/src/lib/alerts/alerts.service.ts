import { HttpStatus, Injectable } from '@nestjs/common';
import { AnalysisClock } from '@raijin/api-analysis';
import { ApiException } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import type { Alert, AlertListQuery, AlertListResponse, AlertReadRequest, AlertUnreadCount } from '@raijin/shared-contracts';
import { PlanLimitsService } from '../plan/plan-limits.service';
import { alertRowSelect, decodeCursor, encodeCursor, toAlert } from './alert-view';

/**
 * Alertes de l'utilisateur (docs/ARCHITECTURE.md §11.2) : liste paginée par curseur (plus récentes
 * d'abord), filtres lu/non lu, types, mint ; historique limité au plan (Gratuit 30 j, Pro 90 j) ;
 * lu/non lu par lot (identifiants d'un autre compte ignorés) et « tout lu ».
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanLimitsService,
    private readonly clock: AnalysisClock,
  ) {}

  async list(userId: string, query: AlertListQuery): Promise<AlertListResponse> {
    const since = await this.since(userId);
    const where: Prisma.AlertWhereInput = { userId, createdAt: { gte: since } };
    if (query.status === 'unread') where.readAt = null;
    if (query.status === 'read') where.readAt = { not: null };
    if (query.types) where.type = { in: query.types };
    if (query.mint) where.mint = query.mint;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (!cursor) throw new ApiException('VALIDATION_ERROR', HttpStatus.BAD_REQUEST, 'Curseur invalide.');
      where.OR = [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }];
    }
    const rows = await this.prisma.alert.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: alertRowSelect,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const items = page.map(toAlert).filter((alert): alert is Alert => alert !== null);
    return {
      items,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
      unread: await this.countUnread(userId, since),
    };
  }

  async unreadCount(userId: string): Promise<AlertUnreadCount> {
    return { unread: await this.countUnread(userId, await this.since(userId)) };
  }

  async markRead(userId: string, body: AlertReadRequest): Promise<AlertUnreadCount> {
    const now = this.clock.now();
    if ('all' in body) {
      await this.prisma.alert.updateMany({ where: { userId, readAt: null }, data: { readAt: now } });
    } else if (body.read) {
      await this.prisma.alert.updateMany({ where: { userId, id: { in: body.ids }, readAt: null }, data: { readAt: now } });
    } else {
      await this.prisma.alert.updateMany({ where: { userId, id: { in: body.ids } }, data: { readAt: null } });
    }
    return this.unreadCount(userId);
  }

  private async since(userId: string): Promise<Date> {
    const { limits } = await this.plans.rights(userId);
    return new Date(this.clock.now().getTime() - limits.alertHistoryDays * 86_400_000);
  }

  private countUnread(userId: string, since: Date): Promise<number> {
    return this.prisma.alert.count({ where: { userId, readAt: null, createdAt: { gte: since } } });
  }
}
