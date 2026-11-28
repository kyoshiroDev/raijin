import { Injectable, Logger } from '@nestjs/common';
import { errorCode } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import { analysisResultSchema, type AnalysisResult, type Plan } from '@raijin/shared-contracts';
import { tokenCountBucket } from './wallet-utils';

/** Propriétés de l'événement `wallet_scanned` : **jamais** l'adresse du wallet, ni un mint, ni un délégué. */
export interface WalletScanEvent {
  readonly userId: string;
  readonly tokenCount: number;
  readonly analyzedCount: number;
  readonly delegationCount: number;
  readonly cached: boolean;
  readonly partial: boolean;
  readonly durationMs: number;
  readonly credits: number;
  readonly plan: Plan;
  readonly trialActive: boolean;
}

export const WALLET_SCAN_EVENT = 'wallet_scanned';

/**
 * Accès base du scan de wallet : lecture des analyses complètes récentes (réutilisées telles
 * quelles) et événement produit. Aucune adresse de wallet ni aucun résultat de scan n'est écrit en
 * base (docs/ARCHITECTURE.md §12.8).
 */
@Injectable()
export class WalletRepository {
  private readonly logger = new Logger('WalletScan');

  constructor(private readonly prisma: PrismaService) {}

  /** Dernière analyse complète de chaque mint enregistrée depuis `since` (une requête pour le lot). */
  async findRecentAnalyses(mints: readonly string[], since: Date): Promise<Map<string, AnalysisResult>> {
    const found = new Map<string, AnalysisResult>();
    if (mints.length === 0) return found;
    try {
      const rows = await this.prisma.tokenAnalysis.findMany({
        where: { mint: { in: [...mints] }, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        distinct: ['mint'],
        select: { mint: true, verdict: true, checks: true, engineVersion: true, token: true, degraded: true, explanation: true, createdAt: true },
      });
      for (const row of rows) {
        // Garde de sortie : une ligne hors contrat n'est jamais réutilisée.
        const parsed = analysisResultSchema.safeParse({
          mint: row.mint,
          token: row.token,
          verdict: row.verdict,
          explanation: row.explanation,
          checks: row.checks,
          engineVersion: row.engineVersion,
          analyzedAt: row.createdAt.toISOString(),
          cached: true,
          degraded: row.degraded,
        });
        if (parsed.success) found.set(row.mint, parsed.data);
      }
    } catch (error) {
      this.logger.warn(`Analyses récentes illisibles, verdicts rapides seulement (${errorCode(error)})`);
    }
    return found;
  }

  /** Événement produit `wallet_scanned` (métriques de l'admin). Ne lève jamais. */
  async recordScan(event: WalletScanEvent): Promise<void> {
    try {
      await this.prisma.productEvent.create({
        data: {
          type: WALLET_SCAN_EVENT,
          userId: event.userId,
          properties: {
            tokenCountBucket: tokenCountBucket(event.tokenCount),
            analyzedCount: event.analyzedCount,
            delegationCount: event.delegationCount,
            cached: event.cached,
            partial: event.partial,
            durationMs: Math.round(event.durationMs),
            credits: event.credits,
            plan: event.plan,
            trialActive: event.trialActive,
          },
        },
      });
    } catch (error) {
      this.logger.error(`Événement ${WALLET_SCAN_EVENT} non enregistré (${errorCode(error)})`);
    }
  }
}
