import * as z from '../zod';
import { solanaAddressSchema } from '../address';
import { riskReasonCodeSchema } from '../analysis/risk';
import { verdictSchema, type Verdict } from '../verdict';

/**
 * Événements de suivi (PROMPT.md §4.2) : détectés par comparaison de deux instantanés d'un mint
 * (`detectWatchEvents` de `@raijin/shared-risk-engine`, règles dans docs/SCORING.md), puis
 * transformés en `Alert` pour chaque utilisateur qui suit le mint.
 */
export const ALERT_TYPES = [
  /** Le verdict passe à un niveau plus grave (Sain → Prudence, Sain ou Prudence → Danger). */
  'verdict_degraded',
  /** Liquidité du pool principal retirée de plus de 30 % (mesure √(base × quote), insensible aux swaps). */
  'lp_removed',
  /** Autorité de mint de nouveau active (création de tokens possible). */
  'mint_reactivated',
  /** Autorité de freeze de nouveau active (gel des comptes possible). */
  'freeze_reactivated',
  /** Un holder de plus de 5 % réduit fortement sa position (vente ou transfert). */
  'holder_sold',
] as const;
export const alertTypeSchema = z.enum(ALERT_TYPES);
export type AlertType = z.infer<typeof alertTypeSchema>;

/** Gravité : `danger` (rouge, icône éclair) ou `warn` (ambre). Jamais la couleur seule. */
export const alertSeveritySchema = z.enum(['warn', 'danger']);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

/** Libellés français courts (filtres, cartes, e-mails, notifications). */
export const ALERT_TYPE_LABELS: Readonly<Record<AlertType, string>> = {
  verdict_degraded: 'Verdict dégradé',
  lp_removed: 'Liquidité retirée',
  mint_reactivated: 'Mint réactivé',
  freeze_reactivated: 'Freeze réactivé',
  holder_sold: 'Gros holder vendeur',
};

/** Ordre de gravité des verdicts : une alerte `verdict_degraded` exige `to` plus grave que `from`. */
export const VERDICT_SEVERITY_RANK: Readonly<Record<Verdict, number>> = { safe: 0, warn: 1, danger: 2 };

const pct = z.number().min(0).max(100);
const usd = z.number().finite().min(0);

export const verdictDegradedPayloadSchema = z
  .object({
    from: verdictSchema,
    to: verdictSchema,
    /** Raisons de la nouvelle analyse (codes stables, phrases dans docs/SCORING.md). */
    reasonCodes: z.array(riskReasonCodeSchema).max(8),
    /** Analyse qui a produit le nouveau verdict (`TokenAnalysis.id`). */
    analysisId: z.uuid().nullable(),
  })
  .refine((value) => VERDICT_SEVERITY_RANK[value.to] > VERDICT_SEVERITY_RANK[value.from], {
    message: 'Le verdict doit se dégrader.',
  });

export const lpRemovedPayloadSchema = z.object({
  poolAddress: solanaAddressSchema,
  /** Identifiant du DEX (DexScreener, donnée externe : réduite à [a-z0-9_-]). */
  dex: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  /** Baisse de √(base × quote) par rapport à la référence, en %. */
  dropPct: pct,
  liquidityUsdBefore: usd.nullable(),
  liquidityUsdAfter: usd.nullable(),
  /** Instant de la référence (plus haut des dernières heures, docs/SCORING.md). */
  referenceAt: z.iso.datetime(),
});

export const authorityReactivatedPayloadSchema = z.object({
  /** Dernier instantané où l'autorité était révoquée. */
  revokedObservedAt: z.iso.datetime(),
});

export const holderSoldPayloadSchema = z.object({
  /** Propriétaire du compte de tokens (adresse publique, affichée tronquée). */
  owner: solanaAddressSchema,
  /** Part de l'offre détenue avant, en % (≥ 5). */
  beforePct: pct,
  /** Part après, en % ; `null` = sorti du top 20 (position inférieure au 20e compte). */
  afterPct: pct.nullable(),
  /** Part de sa position cédée, en %. */
  soldPctOfPosition: pct,
});

/** Couple type + charge utile, commun aux événements détectés et aux alertes. */
export const alertEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('verdict_degraded'), payload: verdictDegradedPayloadSchema }),
  z.object({ type: z.literal('lp_removed'), payload: lpRemovedPayloadSchema }),
  z.object({ type: z.literal('mint_reactivated'), payload: authorityReactivatedPayloadSchema }),
  z.object({ type: z.literal('freeze_reactivated'), payload: authorityReactivatedPayloadSchema }),
  z.object({ type: z.literal('holder_sold'), payload: holderSoldPayloadSchema }),
]);
export type AlertEvent = z.infer<typeof alertEventSchema>;

/**
 * Clé d'idempotence d'un événement : `<type>:<discriminant>` (ex. `lp_removed:<pool>:<referenceAt>`),
 * unique par mint en base. Rejouer une détection (job relancé) ne crée ni événement ni alerte en double.
 */
export const watchEventDedupeKeySchema = z.string().regex(/^[a-z_]+:[A-Za-z0-9:>._-]{1,200}$/);

/** Sortie de `detectWatchEvents` (moteur pur) : événement daté, avec gravité et clé d'idempotence. */
export const watchEventSchema = z.intersection(
  alertEventSchema,
  z.object({
    severity: alertSeveritySchema,
    dedupeKey: watchEventDedupeKeySchema,
    detectedAt: z.iso.datetime(),
  }),
);
export type WatchEvent = z.infer<typeof watchEventSchema>;
