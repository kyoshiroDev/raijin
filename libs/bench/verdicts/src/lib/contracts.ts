import {
  analysisCheckIdSchema,
  mintAddressSchema,
  riskFactsSchema,
  riskReasonCodeSchema,
  verdictSchema,
} from '@raijin/shared-contracts';
import { RISK_ENGINE_VERSION } from '@raijin/shared-risk-engine';
import * as z from './zod';

/**
 * Contrats du suivi des verdicts (phase 7 bis, PROMPT.md §4.8). Propres au banc : ils ne vont pas
 * dans `@raijin/shared-contracts` (aucun projet Raijin ne les lit). Définitions exactes, seuils et
 * méthode : docs/ARCHITECTURE.md §16. Persistance et jobs de collecte : phase 8 bis.
 */

// --- Horizons de suivi -------------------------------------------------------------------------

export const FOLLOW_UP_HORIZONS = ['24h', '72h', '7d'] as const;
export const followUpHorizonSchema = z.enum(FOLLOW_UP_HORIZONS);
export type FollowUpHorizon = z.infer<typeof followUpHorizonSchema>;

const HOUR_MS = 3_600_000;

/** Délai après le verdict et tolérance d'observation (une observation hors fenêtre est écartée). */
export const FOLLOW_UP_WINDOWS: Readonly<Record<FollowUpHorizon, { readonly afterMs: number; readonly toleranceMs: number }>> = {
  '24h': { afterMs: 24 * HOUR_MS, toleranceMs: 6 * HOUR_MS },
  '72h': { afterMs: 72 * HOUR_MS, toleranceMs: 12 * HOUR_MS },
  '7d': { afterMs: 168 * HOUR_MS, toleranceMs: 24 * HOUR_MS },
};

// --- Issues observées --------------------------------------------------------------------------

/** Événements constatés après le verdict. Les trois premiers font un « rug » ; le dernier, un token mort. */
export const OUTCOME_EVENTS = ['LP_REMOVED', 'PRICE_CRASH_90', 'MINT_USED', 'TOKEN_DEAD'] as const;
export const outcomeEventSchema = z.enum(OUTCOME_EVENTS);
export type OutcomeEvent = z.infer<typeof outcomeEventSchema>;

export const RUG_EVENTS: readonly OutcomeEvent[] = ['LP_REMOVED', 'PRICE_CRASH_90', 'MINT_USED'];

/** Issue résumée à un horizon (cumulative : un événement constaté à 24 h reste acquis à 72 h et 7 j). */
export const OUTCOME_STATUSES = ['rug', 'dead', 'alive', 'unknown'] as const;
export const outcomeStatusSchema = z.enum(OUTCOME_STATUSES);
export type OutcomeStatus = z.infer<typeof outcomeStatusSchema>;

/** Seuils de classification (valeurs par défaut : docs/ARCHITECTURE.md §16.2). */
export const outcomeThresholdsSchema = z.object({
  /** Chute de prix (ou de liquidité) qualifiée d'effondrement, en % de la valeur au verdict. */
  crashDropPct: z.number().min(1).max(100),
  /** Liquidité de départ minimale (USD) pour juger une chute de liquidité (en dessous : bruit). */
  liquidityBaselineMinUsd: z.number().min(0),
  /** Liquidité (USD) sous laquelle le token est mort. */
  deadLiquidityUsd: z.number().min(0),
  /** Volume 24 h (USD) sous lequel le token est mort. */
  deadVolume24hUsd: z.number().min(0),
});
export type OutcomeThresholds = z.infer<typeof outcomeThresholdsSchema>;

export const DEFAULT_OUTCOME_THRESHOLDS: OutcomeThresholds = {
  crashDropPct: 90,
  liquidityBaselineMinUsd: 1_000,
  deadLiquidityUsd: 1_000,
  deadVolume24hUsd: 100,
};

/** Quantité entière en unités brutes (u64 en décimal) : comparée en `bigint`, jamais en `number`. */
const rawAmountSchema = z.string().regex(/^\d{1,20}$/);
const usd = z.number().finite().min(0);

/** Mesures de marché prises au verdict (référence des comparaisons). */
export const marketSnapshotSchema = z.object({
  priceUsd: usd.nullable(),
  liquidityUsd: usd.nullable(),
  supplyRaw: rawAmountSchema.nullable(),
});
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;

/** Verdict enregistré par le banc (une ligne par token analysé et par version du moteur). */
export const verdictRecordSchema = z.object({
  id: z.string().min(1).max(64),
  mint: mintAddressSchema,
  /** Égal à `facts.observedAt` : origine des fenêtres de suivi. */
  verdictAt: z.iso.datetime(),
  engineVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  verdict: verdictSchema,
  reasonCodes: z.array(riskReasonCodeSchema).max(40),
  /** Contrôles en `warn` ou `danger` au verdict (pouvoir prédictif par contrôle). */
  flaggedChecks: z.array(analysisCheckIdSchema).max(9),
  baseline: marketSnapshotSchema,
  /** Faits persistés : rejoués par les variantes du moteur. */
  facts: riskFactsSchema,
});
export type VerdictRecord = z.infer<typeof verdictRecordSchema>;

/** Observation de suivi collectée à un horizon (job BullMQ en phase 8 bis). `null` = inconnu. */
export const followUpObservationSchema = z.object({
  recordId: z.string().min(1).max(64),
  horizon: followUpHorizonSchema,
  observedAt: z.iso.datetime(),
  /** Aucun pool actif trouvé (DexScreener et GeckoTerminal). */
  poolFound: z.boolean().nullable(),
  /** LP retirée selon la collecte (même source que `RiskFacts.liquidity.lpRemoved`). */
  lpRemoved: z.boolean().nullable(),
  priceUsd: usd.nullable(),
  liquidityUsd: usd.nullable(),
  volume24hUsd: usd.nullable(),
  supplyRaw: rawAmountSchema.nullable(),
});
export type FollowUpObservation = z.infer<typeof followUpObservationSchema>;

/** Résultat de la classification d'une observation (fonction pure, `outcome.ts`). */
export const outcomeClassificationSchema = z.object({
  recordId: z.string().min(1).max(64),
  horizon: followUpHorizonSchema,
  status: outcomeStatusSchema,
  events: z.array(outcomeEventSchema).max(OUTCOME_EVENTS.length),
});
export type OutcomeClassification = z.infer<typeof outcomeClassificationSchema>;

// --- Variantes du moteur -----------------------------------------------------------------------

/** Identifiant de la référence (moteur publié, configuration par défaut). */
export const REFERENCE_VARIANT_ID = 'reference';

/**
 * Variante du moteur : surcharge de `RiskEngineConfig` (seuils et poids seulement) derrière un
 * identifiant. La version produite est `<RISK_ENGINE_VERSION>-variante.<id>` ; l'empreinte de la
 * configuration (`variant.ts`) distingue deux contenus différents sous le même identifiant.
 */
export const engineVariantSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
    .refine((id) => id !== REFERENCE_VARIANT_ID, { message: 'Identifiant réservé.' }),
  label: z.string().min(1).max(80),
  /** Surcharges numériques de `RiskEngineConfig` (validées par `resolveRiskEngineConfig`). */
  overrides: z.record(z.string().regex(/^[a-zA-Z0-9]{1,40}$/), z.number().finite().min(0)),
  reasonWeights: z.partialRecord(riskReasonCodeSchema, z.number().finite().min(0)).optional(),
});
export type EngineVariant = z.infer<typeof engineVariantSchema>;

/** Version publiée par une variante (`1.0.0-variante.top10-40`) ; la référence garde la version du moteur. */
export function variantEngineVersion(variantId: string): string {
  return variantId === REFERENCE_VARIANT_ID ? RISK_ENGINE_VERSION : `${RISK_ENGINE_VERSION}-variante.${variantId}`;
}

// --- Métriques et rétention --------------------------------------------------------------------

/** Proportion affichée avec son effectif et son intervalle de Wilson à 95 %. */
export const proportionSchema = z.object({
  successes: z.number().int().min(0),
  total: z.number().int().min(0),
  /** `null` si `total` = 0. */
  value: z.number().min(0).max(1).nullable(),
  low: z.number().min(0).max(1).nullable(),
  high: z.number().min(0).max(1).nullable(),
  /** Vrai si `total` < effectif minimal : aucune conclusion ni chiffre marketing. */
  insufficient: z.boolean(),
});
export type Proportion = z.infer<typeof proportionSchema>;

export const retentionPolicySchema = z.object({
  /** Snapshots détaillés (faits bruts de collecte hors verdict) conservés N jours. */
  detailedSnapshotsDays: z.number().int().min(8).max(3_650),
  /** Verdicts enregistrés et observations de suivi (nécessaires aux métriques). */
  verdictRecordsDays: z.number().int().min(30).max(3_650),
  /** Journal des jobs (`job_runs`). */
  jobRunsDays: z.number().int().min(7).max(3_650),
});
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  detailedSnapshotsDays: 30,
  verdictRecordsDays: 365,
  jobRunsDays: 30,
};

export const STORAGE_LEVELS = ['ok', 'warn', 'critical'] as const;
export type StorageLevel = (typeof STORAGE_LEVELS)[number];

/** Seuils de l'alerte de taille de base (part de l'espace alloué). */
export const STORAGE_ALERT_RATIOS: Readonly<{ warn: number; critical: number }> = { warn: 0.8, critical: 0.95 };
