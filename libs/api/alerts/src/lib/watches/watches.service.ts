import { HttpStatus, Injectable } from '@nestjs/common';
import { AnalysisClock, AnalysisService } from '@raijin/api-analysis';
import { ApiException } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import {
  ANALYSIS_ERROR_MESSAGES,
  WATCH_ERROR_MESSAGES,
  WATCH_LIST_MAX,
  type Watch,
  type WatchListResponse,
  type WatchStatus,
} from '@raijin/shared-contracts';
import { PlanLimitsService } from '../plan/plan-limits.service';
import { MintStateService } from '../watch/mint-state.service';
import { parseToken } from '../watch/snapshot';

const watchSelect = {
  id: true,
  mint: true,
  status: true,
  pausedReason: true,
  lastVerdict: true,
  lastCheckedAt: true,
  createdAt: true,
} satisfies Prisma.WatchSelect;
type WatchRow = Prisma.WatchGetPayload<{ select: typeof watchSelect }>;

const notFound = () => new ApiException('WATCH_NOT_FOUND', HttpStatus.NOT_FOUND, WATCH_ERROR_MESSAGES.WATCH_NOT_FOUND);
const limitReached = () => new ApiException('WATCH_LIMIT_REACHED', HttpStatus.FORBIDDEN, WATCH_ERROR_MESSAGES.WATCH_LIMIT_REACHED);

/**
 * Suivis (docs/ARCHITECTURE.md §11.2, §11.5). Limites relues en base à chaque requête ; la création et
 * la reprise verrouillent la ligne de l'utilisateur (`SELECT … FOR UPDATE`) : deux requêtes
 * simultanées ne dépassent jamais la limite. Ressource d'un autre utilisateur : toujours 404.
 */
@Injectable()
export class WatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanLimitsService,
    private readonly analyses: AnalysisService,
    private readonly mintStates: MintStateService,
    private readonly clock: AnalysisClock,
  ) {}

  async list(userId: string): Promise<WatchListResponse> {
    const { limits } = await this.plans.verifiedRights(userId);
    const rows = await this.prisma.watch.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: WATCH_LIST_MAX, select: watchSelect });
    const items = await this.views(userId, rows, limits.alertHistoryDays);
    return {
      items,
      limits,
      activeCount: items.filter((item) => item.status === 'active').length,
      pausedCount: items.filter((item) => item.status === 'paused').length,
    };
  }

  /** `POST watches` : `created` faux si le mint était déjà suivi (200, idempotent). */
  async create(userId: string, mint: string): Promise<{ watch: Watch; created: boolean }> {
    const { limits } = await this.plans.verifiedRights(userId);
    const existing = await this.prisma.watch.findUnique({ where: { userId_mint: { userId, mint } }, select: watchSelect });
    if (existing) return { watch: (await this.views(userId, [existing], limits.alertHistoryDays))[0] as Watch, created: false };
    const analysis = await this.analyses.findLatest(mint);
    if (!analysis) throw new ApiException('ANALYSIS_NOT_FOUND', HttpStatus.NOT_FOUND, ANALYSIS_ERROR_MESSAGES.ANALYSIS_NOT_FOUND);

    let row: WatchRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
        const active = await tx.watch.count({ where: { userId, status: 'active' } });
        const total = await tx.watch.count({ where: { userId } });
        if (active >= limits.maxActiveWatches || total >= WATCH_LIST_MAX) throw limitReached();
        return tx.watch.create({ data: { userId, mint, lastVerdict: analysis.verdict, lastCheckedAt: new Date(analysis.analyzedAt) }, select: watchSelect });
      });
    } catch (error) {
      // Création concurrente du même suivi : on renvoie celui qui existe.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return this.create(userId, mint);
      throw error;
    }
    await this.mintStates.ensure(mint, analysis);
    return { watch: (await this.views(userId, [row], limits.alertHistoryDays))[0] as Watch, created: true };
  }

  /** `PATCH watches/:id` : pause ou reprise (reprise refusée au-delà de la limite du plan). */
  async update(userId: string, id: string, status: WatchStatus): Promise<Watch> {
    const { limits } = await this.plans.verifiedRights(userId);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const current = await tx.watch.findFirst({ where: { id, userId }, select: watchSelect });
      if (!current) throw notFound();
      if (current.status === status) return current;
      if (status === 'active') {
        const active = await tx.watch.count({ where: { userId, status: 'active' } });
        if (active >= limits.maxActiveWatches) throw limitReached();
        return tx.watch.update({ where: { id }, data: { status: 'active', pausedReason: null, pausedAt: null }, select: watchSelect });
      }
      return tx.watch.update({ where: { id }, data: { status: 'paused', pausedReason: 'user', pausedAt: this.clock.now() }, select: watchSelect });
    });
    await this.mintStates.refreshPriority(row.mint);
    return (await this.views(userId, [row], limits.alertHistoryDays))[0] as Watch;
  }

  /** `DELETE watches/:id` (204) ; l'état du mint disparaît quand plus personne ne le suit. */
  async remove(userId: string, id: string): Promise<void> {
    await this.plans.verifiedRights(userId);
    const row = await this.prisma.watch.findFirst({ where: { id, userId }, select: { mint: true } });
    if (!row) throw notFound();
    const deleted = await this.prisma.watch.deleteMany({ where: { id, userId } });
    if (deleted.count === 0) throw notFound();
    await this.mintStates.removeIfUnwatched(row.mint);
    await this.mintStates.refreshPriority(row.mint);
  }

  /**
   * Met en pause (`plan_limit`) les suivis actifs au-delà de la limite du plan, les plus récents
   * d'abord (fin d'essai, phase 6). Renvoie le nombre de suivis mis en pause.
   */
  async enforcePlanLimit(userId: string): Promise<number> {
    const { limits } = await this.plans.rights(userId);
    const paused = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`;
      const active = await tx.watch.findMany({ where: { userId, status: 'active' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, mint: true } });
      const excess = active.slice(limits.maxActiveWatches);
      if (excess.length > 0) {
        await tx.watch.updateMany({
          where: { id: { in: excess.map((watch) => watch.id) } },
          data: { status: 'paused', pausedReason: 'plan_limit', pausedAt: this.clock.now() },
        });
      }
      return excess;
    });
    for (const mint of new Set(paused.map((watch) => watch.mint))) await this.mintStates.refreshPriority(mint);
    return paused.length;
  }

  private async views(userId: string, rows: readonly WatchRow[], historyDays: number): Promise<Watch[]> {
    if (rows.length === 0) return [];
    const mints = [...new Set(rows.map((row) => row.mint))];
    const since = new Date(this.clock.now().getTime() - historyDays * 86_400_000);
    const [states, unread] = await Promise.all([
      this.prisma.mintWatchState.findMany({ where: { mint: { in: mints } }, select: { mint: true, token: true } }),
      this.prisma.alert.groupBy({ by: ['mint'], where: { userId, mint: { in: mints }, readAt: null, createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const tokens = new Map(states.map((state) => [state.mint, parseToken(state.token)]));
    const counts = new Map(unread.map((entry) => [entry.mint, entry._count._all]));
    return rows.map((row) => ({
      id: row.id,
      mint: row.mint,
      token: tokens.get(row.mint) ?? null,
      status: row.status,
      pausedReason: row.status === 'paused' ? (row.pausedReason ?? 'user') : null,
      lastVerdict: row.lastVerdict,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      unreadAlerts: counts.get(row.mint) ?? 0,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
