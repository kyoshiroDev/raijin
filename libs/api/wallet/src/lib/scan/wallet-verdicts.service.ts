import { Inject, Injectable, Logger } from '@nestjs/common';
import { AnalysisClock, KeyValueStore } from '@raijin/api-analysis';
import { APP_CONFIG, errorCode, type AppConfig } from '@raijin/api-core';
import { analysisResultSchema, walletTokenAssessmentSchema, type AnalysisResult, type WalletTokenAssessment } from '@raijin/shared-contracts';
import { canIssueVerdict } from '@raijin/shared-risk-engine';
import { WalletDataSource, type LightBatchEntry } from '../ports/wallet-data-source';
import { fullAssessment, QuickRiskEngine, quickAssessment } from './quick-verdict';
import { WalletRepository } from './wallet.repository';

type Analyzed = Extract<WalletTokenAssessment, { status: 'analyzed' }>;

/** Verdicts des mints à analyser, crédits Helius consommés et indicateur de résultat partiel. */
export interface ResolvedVerdicts {
  readonly assessments: ReadonlyMap<string, WalletTokenAssessment>;
  readonly credits: number;
  /** Échéance ou budget atteints pour au moins un mint. */
  readonly partial: boolean;
}

const TIMEOUT = Symbol('timeout');

/**
 * Verdict de chaque mint à analyser (docs/ARCHITECTURE.md §12.5), du moins coûteux au plus coûteux :
 * 1. analyse complète en cache Redis (`analysis:result:<version>:<mint>`) ;
 * 2. analyse complète en base de moins de `WALLET_REUSE_ANALYSIS_MAX_AGE_S` ;
 * 3. verdict rapide en cache (`wallet:verdict:<version>:<mint>`, partagé entre utilisateurs) ;
 * 4. `collectLightBatch` pour les mints restants, puis moteur D3 ; le verdict rapide est mis en cache
 *    mais **jamais** écrit dans `TokenAnalysis` (la page publique ne montre que des analyses complètes).
 */
@Injectable()
export class WalletVerdictsService {
  private readonly logger = new Logger('WalletScan');

  constructor(
    private readonly source: WalletDataSource,
    private readonly engine: QuickRiskEngine,
    private readonly store: KeyValueStore,
    private readonly repository: WalletRepository,
    private readonly clock: AnalysisClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async resolve(mints: readonly string[], deadlineAt: number): Promise<ResolvedVerdicts> {
    const assessments = new Map<string, WalletTokenAssessment>();
    if (mints.length === 0) return { assessments, credits: 0, partial: false };

    for (const mint of mints) {
      const full = await this.readFullFromCache(mint);
      if (full) assessments.set(mint, fullAssessment(full));
    }
    const maxAgeMs = this.config.wallet.reuseAnalysisMaxAgeS * 1000;
    if (maxAgeMs > 0) {
      const missing = mints.filter((mint) => !assessments.has(mint));
      const recent = await this.repository.findRecentAnalyses(missing, new Date(this.clock.now().getTime() - maxAgeMs));
      for (const [mint, result] of recent) assessments.set(mint, fullAssessment(result));
    }
    for (const mint of mints) {
      if (assessments.has(mint)) continue;
      const quick = await this.readQuickFromCache(mint);
      if (quick) assessments.set(mint, quick);
    }

    const toCollect = mints.filter((mint) => !assessments.has(mint));
    if (toCollect.length === 0) return { assessments, credits: 0, partial: false };

    let credits = 0;
    let partial = false;
    const entries = await this.collectBefore(toCollect, deadlineAt);
    if (entries === TIMEOUT) {
      for (const mint of toCollect) assessments.set(mint, { status: 'unavailable', reason: 'timeout' });
      return { assessments, credits, partial: true };
    }
    credits = entries.credits;
    const byMint = new Map(entries.entries.map((entry) => [entry.mint, entry]));
    for (const mint of toCollect) {
      const assessment = await this.assess(mint, byMint.get(mint));
      if (assessment.status === 'unavailable' && (assessment.reason === 'timeout' || assessment.reason === 'budget')) partial = true;
      assessments.set(mint, assessment);
    }
    return { assessments, credits, partial };
  }

  private async collectBefore(mints: readonly string[], deadlineAt: number) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return TIMEOUT;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), remaining);
    });
    try {
      return await Promise.race([this.source.collectLightBatch(mints, { deadlineAt }), timeout]);
    } catch (error) {
      // Le port ne doit pas lever ; une panne inattendue rend les verdicts indisponibles, sans erreur bloquante.
      this.logger.warn(`Lot de verdicts rapides en échec (${errorCode(error)})`);
      return { entries: mints.map((mint): LightBatchEntry => ({ mint, status: 'unavailable', reason: 'upstream' })), credits: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  private async assess(mint: string, entry: LightBatchEntry | undefined): Promise<WalletTokenAssessment> {
    if (!entry) return { status: 'unavailable', reason: 'timeout' };
    if (entry.status === 'unavailable') return { status: 'unavailable', reason: entry.reason };
    const { facts } = entry.collected;
    // Compte de mint illisible : pas de verdict (règle D1).
    if (facts.mint !== mint || !canIssueVerdict(facts)) return { status: 'unavailable', reason: 'upstream' };
    const assessment = quickAssessment(entry.collected, this.engine.evaluate(facts), this.clock.now());
    await this.store.set(this.quickKey(mint), JSON.stringify(assessment), this.config.wallet.tokenVerdictTtlS * 1000);
    return assessment;
  }

  private quickKey(mint: string): string {
    return `wallet:verdict:${this.engine.version}:${mint}`;
  }

  private async readQuickFromCache(mint: string): Promise<Analyzed | null> {
    const parsed = await this.readJson(this.quickKey(mint), walletTokenAssessmentSchema);
    return parsed?.status === 'analyzed' && parsed.coverage === 'light' ? { ...parsed, fromCache: true } : null;
  }

  private readFullFromCache(mint: string): Promise<AnalysisResult | null> {
    return this.readJson(`analysis:result:${this.engine.version}:${mint}`, analysisResultSchema);
  }

  private async readJson<T>(key: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): Promise<T | null> {
    const raw = await this.store.get(key);
    if (!raw) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
