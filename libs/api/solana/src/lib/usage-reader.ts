import { quotaLevel, type AdminQuotaUsage, type DataSourceId, type QuotaService } from '@raijin/shared-contracts';
import type { UpstreamId } from './core/errors';
import { SYSTEM_CLOCK, type Clock, type CreditLane } from './core/ports';
import type { BreakerState } from './core/upstream-gate';
import {
  UPSTREAM_FAILURE_CATEGORIES,
  assertUtcDay,
  utcDay,
  type CounterUsageRecorder,
  type RawSourceUsage,
  type UpstreamFailureCategory,
  type UpstreamRejection,
} from './core/usage';

/** Consommation d'une source sur un jour UTC. */
export interface UpstreamSourceUsage {
  readonly source: UpstreamId;
  /** Requêtes émises (tentatives, rejeux compris). */
  readonly calls: number;
  readonly successes: number;
  /** Échecs imputables au fournisseur (somme de `failuresByCategory`). */
  readonly failures: number;
  readonly failuresByCategory: Readonly<Record<UpstreamFailureCategory, number>>;
  /** Requêtes annulées par Raijin (échéance, signal) : hors taux d'erreur. */
  readonly cancelled: number;
  /** Réponses > 2 Mo (propriété du compte demandé) : hors taux d'erreur. */
  readonly oversized: number;
  /** Appels refusés avant toute requête (disjoncteur, file pleine, budget, annulation en file). */
  readonly rejections: Readonly<Record<UpstreamRejection, number>>;
  /** failures / (calls − cancelled) ; `null` sans requête. */
  readonly errorRate: number | null;
  /** Latence moyenne des requêtes (ms, entier) ; `null` sans requête. */
  readonly avgLatencyMs: number | null;
  /** État **actuel** du disjoncteur de ce processus (indépendant du jour demandé). */
  readonly breaker: BreakerState;
}

export interface CreditLaneUsage {
  readonly lane: CreditLane;
  readonly used: number;
  /** Plafond propre de la voie ; `null` pour `interactive` (plafonnée par le seul budget global). */
  readonly limit: number | null;
  readonly refused: number;
}

/** Instantané d'un jour UTC (ARCHITECTURE.md §14.1) : base de `AdminHealth.quotas` et des `DailyMetric`. */
export interface UpstreamUsageSnapshot {
  readonly day: string;
  readonly generatedAt: string;
  /** `unavailable` : stockage des compteurs injoignable (compteurs à zéro). */
  readonly status: 'ok' | 'unavailable';
  readonly sources: readonly UpstreamSourceUsage[];
  readonly credits: { readonly used: number; readonly limit: number; readonly refused: number; readonly lanes: readonly CreditLaneUsage[] };
  /** Conformes à `adminQuotaUsageSchema` (ordre de `QUOTA_SERVICES`). */
  readonly quotas: readonly AdminQuotaUsage[];
  /** Requêtes par source de données (`upstream_calls.<source>` de `DAILY_METRICS`) : Helius = RPC + DAS. */
  readonly dailyMetrics: Readonly<Record<`upstream_calls.${DataSourceId}`, number>>;
}

/**
 * Lecteur des compteurs (jeton d'injection Nest : `UpstreamUsageReader`). Fourni par `SolanaDataService.usage`.
 */
export abstract class UpstreamUsageReader {
  /** Instantané du jour UTC `day` (`AAAA-MM-JJ`, défaut : aujourd'hui). `RangeError` si le jour est invalide. */
  abstract snapshot(day?: string): Promise<UpstreamUsageSnapshot>;
}

export interface UsageLimits {
  readonly heliusDailyCreditBudget: number;
  readonly watchDailyCreditBudget: number;
  readonly walletDailyCreditBudget: number;
}

const DATA_SOURCE_OF: Readonly<Record<UpstreamId, DataSourceId>> = {
  helius_rpc: 'helius',
  helius_das: 'helius',
  solana_rpc: 'solana_rpc',
  dexscreener: 'dexscreener',
  geckoterminal: 'geckoterminal',
  jupiter: 'jupiter',
  rugcheck: 'rugcheck',
};

function quota(service: QuotaService, used: number, limit: number | null): AdminQuotaUsage {
  const ratio = limit === null || limit <= 0 ? null : used / limit;
  return { service, period: 'day', used, limit: ratio === null ? null : limit, ratio, level: quotaLevel(ratio) };
}

function sourceUsage(raw: RawSourceUsage, breaker: BreakerState): UpstreamSourceUsage {
  const failuresByCategory = Object.fromEntries(UPSTREAM_FAILURE_CATEGORIES.map((c) => [c, raw.outcomes[c]])) as Record<UpstreamFailureCategory, number>;
  const failures = UPSTREAM_FAILURE_CATEGORIES.reduce((sum, c) => sum + raw.outcomes[c], 0);
  const { success, cancelled, oversized } = raw.outcomes;
  const calls = success + failures + cancelled + oversized;
  const settled = calls - cancelled;
  return {
    source: raw.source,
    calls,
    successes: success,
    failures,
    failuresByCategory,
    cancelled,
    oversized,
    rejections: raw.rejections,
    errorRate: settled > 0 ? Math.min(1, failures / settled) : null,
    avgLatencyMs: calls > 0 ? Math.round(raw.latencyMsTotal / calls) : null,
    breaker,
  };
}

/** Lecteur par défaut : compteurs de l'enregistreur + disjoncteurs + plafonds de la configuration. */
export class CounterUpstreamUsageReader extends UpstreamUsageReader {
  constructor(
    private readonly recorder: CounterUsageRecorder,
    private readonly breakers: () => Readonly<Partial<Record<UpstreamId, BreakerState>>>,
    private readonly limits: UsageLimits,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {
    super();
  }

  async snapshot(day?: string): Promise<UpstreamUsageSnapshot> {
    const now = this.clock.now();
    const target = day === undefined ? utcDay(now) : assertUtcDay(day);
    const raw = await this.recorder.read(target);
    const breakers = this.breakers();
    const sources = raw.sources.map((entry) => sourceUsage(entry, breakers[entry.source] ?? 'closed'));

    const { heliusDailyCreditBudget, watchDailyCreditBudget, walletDailyCreditBudget } = this.limits;
    const laneLimits: Readonly<Record<CreditLane, number | null>> = {
      interactive: null,
      watch: Math.min(watchDailyCreditBudget, heliusDailyCreditBudget),
      wallet: Math.min(walletDailyCreditBudget, heliusDailyCreditBudget),
    };
    const lanes = (['interactive', 'watch', 'wallet'] as const).map(
      (lane): CreditLaneUsage => ({ lane, used: raw.credits.used[lane], limit: laneLimits[lane], refused: raw.credits.refused[lane] }),
    );
    const creditsUsed = lanes.reduce((sum, lane) => sum + lane.used, 0);
    const callsOf = (id: UpstreamId) => sources.find((s) => s.source === id)?.calls ?? 0;

    const dailyMetrics = {} as Record<`upstream_calls.${DataSourceId}`, number>;
    for (const entry of sources) {
      const key = `upstream_calls.${DATA_SOURCE_OF[entry.source]}` as const;
      dailyMetrics[key] = (dailyMetrics[key] ?? 0) + entry.calls;
    }

    return {
      day: target,
      generatedAt: new Date(now).toISOString(),
      status: raw.status,
      sources,
      credits: { used: creditsUsed, limit: heliusDailyCreditBudget, refused: lanes.reduce((sum, lane) => sum + lane.refused, 0), lanes },
      quotas: [
        quota('helius', creditsUsed, heliusDailyCreditBudget),
        quota('helius_watch', raw.credits.used.watch, laneLimits.watch),
        quota('helius_wallet', raw.credits.used.wallet, laneLimits.wallet),
        // API publiques : limites par seconde, aucun plafond journalier documenté → `limit: null`.
        quota('jupiter', callsOf('jupiter'), null),
        quota('rugcheck', callsOf('rugcheck'), null),
        quota('dexscreener', callsOf('dexscreener'), null),
        quota('geckoterminal', callsOf('geckoterminal'), null),
      ],
      dailyMetrics,
    };
  }
}
