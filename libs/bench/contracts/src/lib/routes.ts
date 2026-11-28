/**
 * Routes de l'API du banc (préfixe `/api`), source unique pour le contrôleur Nest et le client
 * Angular (`bench-data-access`). Toute route exige la session du banc sauf `health` et `auth/login` ;
 * toute écriture exige l'en-tête CSRF. Aucune route d'inscription ni de réinitialisation.
 */
export const BENCH_ROUTES = {
  health: 'health',
  status: 'status',
  authLogin: 'auth/login',
  authSession: 'auth/session',
  authLogout: 'auth/logout',
  events: 'events',
  tokens: 'tokens',
  tokenBriefs: 'tokens/briefs',
  token: 'tokens/:mint',
  tokenSnapshots: 'tokens/:mint/snapshots',
  marketRates: 'market/rates',
  alerts: 'alerts',
  alertSettings: 'settings/alerts',
  alertEnabled: 'settings/alerts/enabled',
  preferences: 'settings/preferences',
  pushVapidKey: 'push/vapid-public-key',
  pushSubscriptions: 'push/subscriptions',
  pushUnsubscribe: 'push/unsubscribe',
  pushTest: 'push/test',
  paperWallets: 'paper/wallets',
  paperWalletReset: 'paper/wallets/:book/reset',
  paperPositions: 'paper/positions',
  paperPositionCancel: 'paper/positions/:id/cancel',
  performancePresets: 'performance/presets',
  performanceBooks: 'performance/books',
  performanceBreakdown: 'performance/breakdown',
  labRuns: 'lab/runs',
  labRunResults: 'lab/runs/:id/results',
  labBackfill: 'lab/backfill',
  /** Rapport de justesse (`QualityReport` de `@raijin/bench-verdicts`, calculé côté API). */
  verdictQuality: 'verdicts/quality',
  shadowComparison: 'shadow/comparison',
  jobRuns: 'jobs/runs',
} as const;
export type BenchRoute = (typeof BENCH_ROUTES)[keyof typeof BENCH_ROUTES];
