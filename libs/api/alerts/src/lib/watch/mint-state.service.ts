import { Inject, Injectable } from '@nestjs/common';
import { AnalysisClock } from '@raijin/api-analysis';
import { APP_CONFIG, type AppConfig } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import type { AnalysisResult } from '@raijin/shared-contracts';
import { mergeWatchSnapshot } from '@raijin/shared-risk-engine';
import { initialSchedule } from './planner.service';

/**
 * État par mint (`MintWatchState`), partagé entre les utilisateurs qui suivent le mint : créé au
 * premier suivi (référence de verdict = analyse récente, échéances étalées), priorité recalculée
 * (1 si un Pro ou l'essai le suit), supprimé quand plus personne ne le suit.
 */
@Injectable()
export class MintStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: AnalysisClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async ensure(mint: string, analysis: AnalysisResult): Promise<void> {
    const now = this.clock.now();
    const reasonCodes = [...new Set(analysis.checks.flatMap((check) => check.reasonCodes))].slice(0, 40);
    const snapshot = mergeWatchSnapshot(null, {
      mint,
      verdict: { verdict: analysis.verdict, engineVersion: analysis.engineVersion, analysisId: null, reasonCodes, observedAt: analysis.analyzedAt },
    });
    await this.prisma.mintWatchState.upsert({
      where: { mint },
      create: {
        mint,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        token: analysis.token as unknown as Prisma.InputJsonValue,
        ...initialSchedule(mint, now, this.config),
      },
      update: {},
    });
    await this.refreshPriority(mint);
  }

  /** Priorité 1 si au moins un suivi actif d'un compte Pro ou en essai. */
  async refreshPriority(mint: string): Promise<void> {
    const now = this.clock.now();
    const pro = await this.prisma.watch.count({
      where: {
        mint,
        status: 'active',
        user: { OR: [{ plan: 'PRO' }, { trialStatus: 'ACTIVE', trialEndsAt: { gt: now } }] },
      },
    });
    await this.prisma.mintWatchState.updateMany({ where: { mint }, data: { priority: pro > 0 ? 1 : 0 } });
  }

  /** Plus aucun suivi (actif ou en pause) : l'état du mint est supprimé. */
  async removeIfUnwatched(mint: string): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM "MintWatchState" s WHERE s."mint" = ${mint}
      AND NOT EXISTS (SELECT 1 FROM "Watch" w WHERE w."mint" = s."mint")`;
  }
}
