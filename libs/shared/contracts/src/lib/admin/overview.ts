import * as z from '../zod';
import {
  metricSourceSchema,
  metricStatusSchema,
  metricUnitSchema,
  ratioSchema,
  resolvedRangeSchema,
  timeSeriesSchema,
} from './common';
import { googleServiceStateSchema } from './google';

/**
 * Vue d'ensemble (écran 1). Route : `GET admin/overview?period=7d` (`adminRangeQuerySchema`) → `AdminOverview`.
 * Jours passés lus dans `DailyMetric`, jour en cours calculé en direct (cache 60 s) : l'écran reste instantané.
 */
export const ADMIN_KPI_KEYS = [
  'landing_visitors',
  'signups',
  'verified_accounts',
  'active_trials',
  'trial_conversions',
  'mrr_cents',
  'active_subscribers',
  'churn_rate',
  'analyses',
  'alerts_sent',
] as const;
export const adminKpiKeySchema = z.enum(ADMIN_KPI_KEYS);
export type AdminKpiKey = z.infer<typeof adminKpiKeySchema>;

export const ADMIN_KPI_LABELS: Readonly<Record<AdminKpiKey, string>> = {
  landing_visitors: 'Visiteurs de la landing',
  signups: 'Inscriptions',
  verified_accounts: 'Comptes vérifiés',
  active_trials: 'Essais en cours',
  trial_conversions: 'Conversions essai → Pro',
  mrr_cents: 'MRR',
  active_subscribers: 'Abonnés actifs',
  churn_rate: 'Churn',
  analyses: 'Analyses',
  alerts_sent: 'Alertes envoyées',
};

/**
 * KPI d'une période avec sa variation. `change` = (valeur − précédente) / |précédente| (`computeChange`).
 * Pour `churn_rate`, une hausse est mauvaise : `higherIsBetter` guide la couleur de la variation (avec icône).
 */
export const adminKpiSchema = z.object({
  key: adminKpiKeySchema,
  unit: metricUnitSchema,
  value: z.number().nullable(),
  previous: z.number().nullable(),
  change: z.number().nullable(),
  higherIsBetter: z.boolean(),
  source: metricSourceSchema,
  status: metricStatusSchema,
});
export type AdminKpi = z.infer<typeof adminKpiSchema>;

/** Entonnoir complet : visites (GA4) → analyse démo → inscription → e-mail vérifié → essai → Pro. */
export const FUNNEL_STEPS = [
  'landing_visits',
  'demo_analyses',
  'signups',
  'email_verified',
  'trials_started',
  'pro_conversions',
] as const;
export const funnelStepKeySchema = z.enum(FUNNEL_STEPS);
export type FunnelStepKey = z.infer<typeof funnelStepKeySchema>;

export const FUNNEL_STEP_LABELS: Readonly<Record<FunnelStepKey, string>> = {
  landing_visits: 'Visites',
  demo_analyses: 'Analyse démo',
  signups: 'Inscription',
  email_verified: 'E-mail vérifié',
  trials_started: 'Essai',
  pro_conversions: 'Pro',
};

export const funnelStepSchema = z.object({
  key: funnelStepKeySchema,
  value: z.number().int().min(0).nullable(),
  /**
   * Part de l'étape précédente qui atteint celle-ci, plafonnée à 1 (`funnelStepRate`) ; `null` pour la première, si une
   * valeur manque ou si l'étape précédente vaut 0.
   */
  rateFromPrevious: ratioSchema.nullable(),
  /**
   * `true` si la valeur dépasse celle de l'étape précédente (sources différentes, ex. visites GA4 non connectées ou
   * inscriptions sans analyse démo) : le taux affiché est plafonné à 100 % et l'écran l'explique.
   */
  exceedsPrevious: z.boolean().default(false),
  /** `demo_analyses` : événement GA4 `analyse_demo_lancee` si GA4 est connecté, sinon analyses anonymes internes. */
  source: metricSourceSchema,
  status: metricStatusSchema,
});
export type FunnelStep = z.infer<typeof funnelStepSchema>;

/** Taux d'une étape de l'entonnoir : jamais au-delà de 100 %, dépassement signalé (`exceedsPrevious`). */
export function funnelStepRate(value: number | null, previous: number | null): Pick<FunnelStep, 'rateFromPrevious' | 'exceedsPrevious'> {
  if (value === null || previous === null || previous === 0) return { rateFromPrevious: null, exceedsPrevious: false };
  return { rateFromPrevious: Math.min(1, value / previous), exceedsPrevious: value > previous };
}

export const adminOverviewSchema = z.object({
  generatedAt: z.iso.datetime(),
  range: resolvedRangeSchema,
  /** Dans l'ordre de `ADMIN_KPI_KEYS`. */
  kpis: z.array(adminKpiSchema).length(ADMIN_KPI_KEYS.length),
  /** Tendance : inscriptions et analyses (avec la période précédente en comparaison). */
  trend: z.array(timeSeriesSchema).max(4),
  funnel: z.array(funnelStepSchema).length(FUNNEL_STEPS.length),
  ga4: googleServiceStateSchema,
  /** Dernier jour complet présent dans `DailyMetric` ; `null` avant le premier passage du job nocturne. */
  aggregatedThrough: z.iso.date().nullable(),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
