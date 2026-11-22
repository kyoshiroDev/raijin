import { Injectable, Logger } from '@nestjs/common';
import { errorCode } from '@raijin/api-core';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import { analysisResultSchema, type AnalysisResult } from '@raijin/shared-contracts';
import type { CollectedFacts } from '../ports/facts-collector';

/** Une analyse publiée reste visible sur la page publique pendant 24 h. */
export const PUBLISHED_ANALYSIS_MAX_AGE_MS = 24 * 3_600_000;

export interface AnalysisEvent {
  readonly userId: string | null;
  readonly mint: string;
  readonly verdict: AnalysisResult['verdict'];
  readonly cached: boolean;
  readonly degraded: boolean;
  readonly engineVersion: string;
  readonly durationMs: number;
  readonly subject: 'user' | 'anonymous';
}

/** Persistance des analyses (`TokenAnalysis`) et événement produit `analysis_done`. */
@Injectable()
export class AnalysisRepository {
  private readonly logger = new Logger('AnalysisRepository');

  constructor(private readonly prisma: PrismaService) {}

  /** Enregistre une analyse fraîche. Ne lève jamais : la réponse à l'utilisateur prime. */
  async save(result: AnalysisResult, collected: CollectedFacts, durationMs: number, userId: string | null): Promise<void> {
    try {
      await this.prisma.tokenAnalysis.create({
        data: {
          mint: result.mint,
          verdict: result.verdict,
          checks: result.checks as unknown as Prisma.InputJsonValue,
          sources: collected.sources as unknown as Prisma.InputJsonValue,
          engineVersion: result.engineVersion,
          facts: collected.facts as unknown as Prisma.InputJsonValue,
          token: result.token as unknown as Prisma.InputJsonValue,
          degraded: result.degraded,
          explanation: result.explanation,
          durationMs: Math.round(durationMs),
          userId,
          createdAt: new Date(result.analyzedAt),
        },
      });
    } catch (error) {
      this.logger.error(`Analyse non enregistrée (${errorCode(error)})`);
    }
  }

  /** Dernière analyse publiée de moins de 24 h (page publique), ou `null`. */
  async findLatest(mint: string, now: Date): Promise<AnalysisResult | null> {
    const row = await this.prisma.tokenAnalysis.findFirst({
      where: { mint, createdAt: { gte: new Date(now.getTime() - PUBLISHED_ANALYSIS_MAX_AGE_MS) } },
      orderBy: { createdAt: 'desc' },
      select: {
        mint: true,
        verdict: true,
        checks: true,
        engineVersion: true,
        token: true,
        degraded: true,
        explanation: true,
        createdAt: true,
      },
    });
    if (!row) return null;
    // Garde de sortie : une ligne ancienne ou altérée hors contrat n'est jamais renvoyée.
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
    return parsed.success ? parsed.data : null;
  }

  /** Événement produit (métriques de l'admin). Ne lève jamais. */
  async recordEvent(event: AnalysisEvent): Promise<void> {
    try {
      await this.prisma.productEvent.create({
        data: {
          type: 'analysis_done',
          userId: event.userId,
          properties: {
            mint: event.mint,
            verdict: event.verdict,
            cached: event.cached,
            degraded: event.degraded,
            engineVersion: event.engineVersion,
            durationMs: Math.round(event.durationMs),
            subject: event.subject,
          },
        },
      });
    } catch (error) {
      this.logger.error(`Événement analysis_done non enregistré (${errorCode(error)})`);
    }
  }
}
