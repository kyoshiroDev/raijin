import { quotaLevel, type AdminQuotaUsage, type QuotaService } from '@raijin/shared-contracts';
import type { UpstreamUsageSnapshot } from '@raijin/api-solana';

/** Plafonds journaliers configurés pour les API publiques (`*_DAILY_CALL_BUDGET`) ; `null` = sans plafond. */
export interface CallBudgets {
  readonly jupiterDailyCallBudget: number | null;
  readonly rugcheckDailyCallBudget: number | null;
}

/**
 * Consommations du jour (instantané de `api-solana`) avec les plafonds Jupiter / RugCheck de la configuration
 * (`api-solana` n'en connaît pas : limites par seconde seulement). Niveau recalculé au seuil configuré.
 */
export function quotasWithBudgets(snapshot: Pick<UpstreamUsageSnapshot, 'quotas'>, budgets: CallBudgets, threshold: number): AdminQuotaUsage[] {
  const override: Partial<Record<QuotaService, number | null>> = {
    jupiter: budgets.jupiterDailyCallBudget,
    rugcheck: budgets.rugcheckDailyCallBudget,
  };
  return snapshot.quotas.map((quota) => {
    const limit = quota.service in override ? (override[quota.service] ?? null) : quota.limit;
    const ratio = limit === null || limit <= 0 ? null : quota.used / limit;
    return { ...quota, limit: ratio === null ? null : limit, ratio, level: quotaLevel(ratio, threshold) };
  });
}
