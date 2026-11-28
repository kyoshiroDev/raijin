import * as z from '../zod';
import { dataSourceIdSchema } from '../analysis/sources';
import { mintAddressSchema } from '../address';
import { billingModeSchema } from '../billing/plans';
import { trialConversionReportSchema } from '../trial/admin';
import { verdictSchema } from '../verdict';
import {
  ADMIN_TOP_ROWS_MAX,
  adminRangeQueryShape,
  centsSchema,
  countSchema,
  externalText,
  ratioSchema,
  resolvedRangeSchema,
  timeSeriesSchema,
  withRangeRefinement,
} from './common';
import { googleServiceStateSchema } from './google';

// =============================================================================================
// Acquisition (écran 4) : inscrits et payants par source UTM, campagne, page d'arrivée (table User, en direct,
// cache 5 min). Jointure avec les sessions GA4 par source quand GA4 est connecté.
// Route : `GET admin/acquisition?dimension=source&period=30d` → `AdminAcquisition`.
// =============================================================================================

export const ACQUISITION_DIMENSIONS = ['source', 'medium', 'campaign', 'landing_path', 'referrer_host'] as const;
export const acquisitionDimensionSchema = z.enum(ACQUISITION_DIMENSIONS);
export type AcquisitionDimension = z.infer<typeof acquisitionDimensionSchema>;

export const ACQUISITION_DIMENSION_LABELS: Readonly<Record<AcquisitionDimension, string>> = {
  source: 'Source',
  medium: 'Support',
  campaign: 'Campagne',
  landing_path: 'Page d’arrivée',
  referrer_host: 'Site référent',
};

/** Libellé affiché pour une valeur absente (`value: null`) : visite directe ou inconnue. */
export const ACQUISITION_DIRECT_LABEL = '(direct ou inconnu)';

export const adminAcquisitionQuerySchema = withRangeRefinement(
  z.object({ ...adminRangeQueryShape, dimension: acquisitionDimensionSchema.default('source') }),
);
export type AdminAcquisitionQuery = z.infer<typeof adminAcquisitionQuerySchema>;

export const ADMIN_ACQUISITION_ROWS_MAX = 50;

export const acquisitionRowSchema = z.object({
  /** Valeur de la dimension (texte hostile, échappé à l'affichage) ; `null` = direct ou inconnu. */
  value: externalText(512).nullable(),
  signups: countSchema,
  verified: countSchema,
  trials: countSchema,
  /** Inscrits de la période devenus payants (abonnement Pro actif ou `past_due`). */
  payers: countSchema,
  /** payers / signups ; `null` sans inscrit. */
  conversionRate: ratioSchema.nullable(),
  /** MRR actuel des payants de cette ligne. */
  mrrCents: centsSchema,
  /** Sessions GA4 de la même source (dimension `source` seulement) ; `null` sinon ou GA4 non connecté. */
  ga4Sessions: countSchema.nullable(),
});
export type AcquisitionRow = z.infer<typeof acquisitionRowSchema>;

export const adminAcquisitionSchema = z.object({
  range: resolvedRangeSchema,
  dimension: acquisitionDimensionSchema,
  rows: z.array(acquisitionRowSchema).max(ADMIN_ACQUISITION_ROWS_MAX),
  totals: z.object({ signups: countSchema, verified: countSchema, trials: countSchema, payers: countSchema }),
  ga4: googleServiceStateSchema,
});
export type AdminAcquisition = z.infer<typeof adminAcquisitionSchema>;

// =============================================================================================
// Revenus (écran 5) : table Subscription et événements de facturation (aucun appel à l'API Stripe).
// Route : `GET admin/revenue?period=30d` (`adminRangeQuerySchema`) → `AdminRevenue`.
// =============================================================================================

export const adminRevenueSchema = z.object({
  range: resolvedRangeSchema,
  mode: billingModeSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  mrrCents: centsSchema,
  mrrPreviousCents: centsSchema.nullable(),
  mrrSeries: timeSeriesSchema,
  activeSubscribers: countSchema,
  newSubscribers: countSchema,
  cancellations: countSchema,
  failedPayments: countSchema,
  /** Résiliations / abonnés actifs au début de la période ; `null` si aucun abonné au début. */
  churnRate: ratioSchema.nullable(),
  intervalSplit: z.object({ month: countSchema, year: countSchema }),
  revenueBySource: z
    .array(z.object({ source: externalText(200).nullable(), payers: countSchema, mrrCents: centsSchema }))
    .max(ADMIN_TOP_ROWS_MAX),
});
export type AdminRevenue = z.infer<typeof adminRevenueSchema>;

// =============================================================================================
// Essais (écran 6). Route : `GET admin/trials` → `AdminTrials` (remplace l'écran provisoire de la phase 6 ;
// `GET admin/trial-conversion` reste servi derrière la même garde admin).
// =============================================================================================

export const adminTrialsSchema = z.object({
  generatedAt: z.iso.datetime(),
  activeTrials: countSchema,
  endingWithin48h: countSchema,
  /** Cohortes par semaine et refus de l'anti-abus (`refusals` = comptes bloqués). */
  conversion: trialConversionReportSchema,
  /** Raisons de non-conversion déclarées ; vide tant qu'aucune n'est collectée (v1). */
  nonConversionReasons: z.array(z.object({ reason: externalText(200), count: countSchema })).max(ADMIN_TOP_ROWS_MAX),
});
export type AdminTrials = z.infer<typeof adminTrialsSchema>;

// =============================================================================================
// Produit (écran 8). Route : `GET admin/product?period=30d` (`adminRangeQuerySchema`) → `AdminProduct`.
// =============================================================================================

export const ADMIN_TOP_TOKENS_MAX = 20;

export const adminProductSchema = z.object({
  range: resolvedRangeSchema,
  analysesTotal: countSchema,
  /** `analyses_total` par jour (comparaison : période précédente). */
  analysesSeries: timeSeriesSchema,
  verdictSplit: z.record(verdictSchema, countSchema),
  topTokens: z
    .array(
      z.object({
        mint: mintAddressSchema,
        /** Symbole et nom on-chain : hostiles, échappés, `null` si inconnus. */
        symbol: externalText(32).nullable(),
        name: externalText(64).nullable(),
        analyses: countSchema,
      }),
    )
    .max(ADMIN_TOP_TOKENS_MAX),
  responseTimeMs: z.object({ average: z.number().min(0).nullable(), p95: z.number().min(0).nullable() }),
  responseTimeSeries: timeSeriesSchema,
  unavailableBySource: z.array(
    z.object({ source: dataSourceIdSchema, checks: countSchema, unavailable: countSchema, rate: ratioSchema.nullable() }),
  ),
  walletScans: countSchema,
  activeWatches: countSchema,
});
export type AdminProduct = z.infer<typeof adminProductSchema>;
