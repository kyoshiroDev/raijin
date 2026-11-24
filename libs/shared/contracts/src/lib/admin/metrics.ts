import * as z from '../zod';
import { DATA_SOURCE_IDS } from '../analysis/sources';
import type { MetricUnit } from './common';

/**
 * Catalogue des agrégats quotidiens `DailyMetric` (`date` = jour UTC, `key`, `value`), calculés par le job nocturne
 * `metrics-aggregate` (docs/ARCHITECTURE.md §14.5). **Aucune donnée personnelle** : uniquement des comptes, sommes,
 * moyennes et instantanés. Une clé hors catalogue est refusée à l'écriture.
 *
 * - `sum` : flux du jour, additionné sur une période (inscriptions, analyses…) ;
 * - `last` : instantané de fin de journée, la période prend la dernière valeur (MRR, abonnés actifs…) ;
 * - `avg` : moyenne du jour, la période fait la moyenne pondérée par `weight` (clé de poids indiquée).
 */
export type DailyMetricAggregation = 'sum' | 'last' | 'avg';

export interface DailyMetricDefinition {
  readonly unit: MetricUnit;
  readonly aggregation: DailyMetricAggregation;
  /** Pour `avg` : clé du même jour qui sert de poids (ex. nombre d'analyses pour le temps moyen). */
  readonly weight?: string;
}

export const DAILY_METRICS = {
  // Comptes et essai
  signups: { unit: 'count', aggregation: 'sum' },
  email_verified: { unit: 'count', aggregation: 'sum' },
  trials_started: { unit: 'count', aggregation: 'sum' },
  trials_converted: { unit: 'count', aggregation: 'sum' },
  trials_expired: { unit: 'count', aggregation: 'sum' },
  trials_refused: { unit: 'count', aggregation: 'sum' },
  trials_active: { unit: 'count', aggregation: 'last' },
  accounts_deleted: { unit: 'count', aggregation: 'sum' },
  // Abonnements (table Subscription et événements de facturation)
  subscriptions_new: { unit: 'count', aggregation: 'sum' },
  subscriptions_canceled: { unit: 'count', aggregation: 'sum' },
  payments_failed: { unit: 'count', aggregation: 'sum' },
  subscribers_active: { unit: 'count', aggregation: 'last' },
  subscribers_monthly: { unit: 'count', aggregation: 'last' },
  subscribers_yearly: { unit: 'count', aggregation: 'last' },
  /** MRR de fin de journée : mensuels + annuels / 12, en centimes (abonnements Pro actifs et `past_due`). */
  mrr_cents: { unit: 'cents', aggregation: 'last' },
  // Produit
  analyses_total: { unit: 'count', aggregation: 'sum' },
  /** Analyses sans compte : étape « analyse démo » de l'entonnoir tant que GA4 n'est pas connecté. */
  analyses_anonymous: { unit: 'count', aggregation: 'sum' },
  /** Analyses en échec complet (aucun résultat rendu : erreur, échéance, source principale indisponible). */
  analyses_failed: { unit: 'count', aggregation: 'sum' },
  /** Analyses rendues avec un résultat partiel (au moins un contrôle « indisponible »), distinctes des échecs. */
  analyses_partial: { unit: 'count', aggregation: 'sum' },
  verdict_safe: { unit: 'count', aggregation: 'sum' },
  verdict_warn: { unit: 'count', aggregation: 'sum' },
  verdict_danger: { unit: 'count', aggregation: 'sum' },
  analysis_duration_avg_ms: { unit: 'ms', aggregation: 'avg', weight: 'analyses_total' },
  analysis_duration_p95_ms: { unit: 'ms', aggregation: 'last' },
  wallet_scans: { unit: 'count', aggregation: 'sum' },
  watches_active: { unit: 'count', aggregation: 'last' },
  alerts_sent: { unit: 'count', aggregation: 'sum' },
  push_sent: { unit: 'count', aggregation: 'sum' },
  push_subscriptions_active: { unit: 'count', aggregation: 'last' },
  // Technique
  emails_sent: { unit: 'count', aggregation: 'sum' },
  emails_failed: { unit: 'count', aggregation: 'sum' },
  api_requests: { unit: 'count', aggregation: 'sum' },
  api_errors_5xx: { unit: 'count', aggregation: 'sum' },
  helius_credits: { unit: 'count', aggregation: 'sum' },
  db_size_bytes: { unit: 'bytes', aggregation: 'last' },
} as const satisfies Record<string, DailyMetricDefinition>;

export type DailyMetricBaseKey = keyof typeof DAILY_METRICS;

/**
 * Familles déclinées par source de données (`checks.dexscreener`, `checks_unavailable.rugcheck`,
 * `upstream_calls.jupiter`…) : taux de contrôles « indisponibles » par source et consommation des API externes.
 */
export const DAILY_METRIC_SOURCE_FAMILIES = ['checks', 'checks_unavailable', 'upstream_calls'] as const;
export type DailyMetricSourceFamily = (typeof DAILY_METRIC_SOURCE_FAMILIES)[number];

export type DailyMetricKey = DailyMetricBaseKey | `${DailyMetricSourceFamily}.${(typeof DATA_SOURCE_IDS)[number]}`;

export function isDailyMetricKey(value: string): value is DailyMetricKey {
  if (Object.prototype.hasOwnProperty.call(DAILY_METRICS, value)) return true;
  const [family, source, extra] = value.split('.');
  return (
    extra === undefined &&
    (DAILY_METRIC_SOURCE_FAMILIES as readonly string[]).includes(family ?? '') &&
    (DATA_SOURCE_IDS as readonly string[]).includes(source ?? '')
  );
}

/** Définition d'une clé (les familles par source sont des comptes additionnés). */
export function dailyMetricDefinition(key: DailyMetricKey): DailyMetricDefinition {
  if (Object.prototype.hasOwnProperty.call(DAILY_METRICS, key)) return DAILY_METRICS[key as DailyMetricBaseKey];
  return { unit: 'count', aggregation: 'sum' };
}

export const dailyMetricKeySchema = z.string().refine(isDailyMetricKey, { message: 'Métrique inconnue.' });
