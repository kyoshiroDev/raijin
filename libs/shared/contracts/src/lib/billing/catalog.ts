import type { BillingPlansResponse } from './plans';

/**
 * Catalogue public des plans, **valeurs par défaut** de la configuration de l'API (docs/ARCHITECTURE.md §15.2).
 *
 * - La landing (statique, zéro JS) l'affiche au build : pas d'appel à l'API pendant le build ni à l'exécution.
 * - L'API (`api-core` / `api-billing`) en tire les défauts de `PRO_PRICE_*_CENTS`, `*_ANALYSIS_DAILY_LIMIT`,
 *   `*_WATCH_LIMIT`, `*_ALERT_HISTORY_DAYS`, `WALLET_SCAN_DAILY_LIMIT_*`, `TRIAL_DAYS` ; en production, une valeur
 *   d'environnement différente est journalisée au démarrage (« landing désalignée ») : changer un prix =
 *   modifier ce fichier, puis reconstruire l'API et la landing.
 * - `GET billing/plans` reste la source des écrans de l'app (valeurs effectives).
 *
 * Aucun Zod ici : importé par la landing (`import` au build, jamais dans un îlot client).
 */
export interface PublicPlanCatalog extends Omit<BillingPlansResponse, 'mode'> {
  /** Analyses par jour sans compte (quota par empreinte d'IP, `ANON_ANALYSIS_DAILY_LIMIT`). */
  readonly anonAnalysesPerDay: number;
}

export const PUBLIC_PLAN_CATALOG: PublicPlanCatalog = {
  anonAnalysesPerDay: 3,
  free: {
    plan: 'FREE',
    entitlements: {
      analysesPerDay: 5,
      maxActiveWatches: 3,
      pushAlerts: false,
      walletScansPerDay: 0,
      alertHistoryDays: 30,
    },
  },
  pro: {
    plan: 'PRO',
    entitlements: {
      analysesPerDay: null,
      maxActiveWatches: 50,
      pushAlerts: true,
      walletScansPerDay: 20,
      alertHistoryDays: 90,
    },
    monthly: { interval: 'month', amountCents: 990, currency: 'EUR' },
    yearly: { interval: 'year', amountCents: 9900, currency: 'EUR' },
  },
  trial: {
    days: 7,
    entitlements: {
      analysesPerDay: 50,
      maxActiveWatches: 50,
      pushAlerts: true,
      walletScansPerDay: 10,
      alertHistoryDays: 90,
    },
  },
};
