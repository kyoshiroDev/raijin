import * as z from '../zod';
import { mintAddressSchema, solanaAddressSchema } from '../address';
import { checkStatusSchema, verdictSchema } from '../verdict';
import { analysisCheckIdSchema } from './checks';
import { tokenProgramSchema } from './token';

/**
 * Entrée et sortie de `@raijin/shared-risk-engine` (moteur pur, PROMPT.md §4.1).
 *
 * Les faits sont **normalisés et indépendants des sources** : le moteur ne sait pas d'où ils
 * viennent et ne fait aucun appel. Un groupe à `null` = donnée indisponible (source en panne,
 * clé Helius absente, quota épuisé) : le contrôle correspondant passe en `unavailable`.
 * Les faits sont persistés (`TokenAnalysis.facts`) pour que le banc rejoue des variantes du
 * moteur sur l'historique (PROMPT.md §4.8).
 */

const pct = z.number().min(0).max(100);
const nonNegative = z.number().finite().min(0);

export const RISK_FACTS_VERSION = 1;

export const mintAccountFactsSchema = z.object({
  mintAuthorityActive: z.boolean(),
  freezeAuthorityActive: z.boolean(),
  tokenProgram: tokenProgramSchema,
  /** Extensions Token-2022 à risque (toutes à `false` / `null` pour un token SPL classique). */
  extensions: z.object({
    transferFeeBps: z.number().int().min(0).max(10_000).nullable(),
    permanentDelegate: z.boolean(),
    transferHook: z.boolean(),
    nonTransferable: z.boolean(),
  }),
});

export const metadataFactsSchema = z.object({
  /** Vrai si une update authority peut encore modifier les métadonnées. */
  mutable: z.boolean(),
});

export const liquidityFactsSchema = z.object({
  /** Médiane des liquidités en USD des sources disponibles (DexScreener, GeckoTerminal). */
  usd: nonNegative.nullable(),
  /** Échantillons utilisés pour la médiane. */
  samples: z
    .array(z.object({ source: z.enum(['dexscreener', 'geckoterminal']), usd: nonNegative }))
    .max(10),
  /** Part de la LP brûlée ou verrouillée (pool principal), en %. */
  lpBurnedOrLockedPct: pct.nullable(),
  /** LP retirée : liquidité effondrée ou pool vidé (signal critique). */
  lpRemoved: z.boolean().nullable(),
});

export const holderFactsSchema = z.object({
  /** Part du top 10, LP et programmes connus exclus, en %. */
  top10Pct: pct,
  /** Plus grosse part détenue par un seul wallet (mêmes exclusions), en %. */
  maxSingleHolderPct: pct,
  /** Nombre de comptes exclus (LP, programmes connus). */
  excludedAccounts: z.number().int().min(0),
});

export const sellSimulationFactsSchema = z.object({
  /** Un devis de vente (token → SOL/USDC) existe. `false` = honeypot probable. */
  routeFound: z.boolean(),
  /** Impact prix du devis, en %. */
  priceImpactPct: pct.nullable(),
  /** Taxe implicite estimée (écart devis / prix de marché hors impact), en %. */
  implicitTaxPct: pct.nullable(),
  /** Montant simulé en USD (devis seulement, aucune transaction signée ni exécutée). */
  testAmountUsd: nonNegative,
});

export const ageFactsSchema = z.object({
  tokenCreatedAt: z.iso.datetime().nullable(),
  poolCreatedAt: z.iso.datetime().nullable(),
});

export const creatorFactsSchema = z.object({
  /** Adresse publique du créateur (affichée tronquée). */
  address: solanaAddressSchema.nullable(),
  tokensLaunched: z.number().int().min(0),
  tokensDeadOrRugged: z.number().int().min(0),
});

export const rugcheckFactsSchema = z.object({
  /** Score normalisé RugCheck (0 = sûr, 100 = risqué selon RugCheck). */
  scoreNormalised: pct.nullable(),
  rugged: z.boolean().nullable(),
  /** Risques signalés par RugCheck : libellés externes non fiables, nettoyés et bornés. */
  risks: z
    .array(
      z.object({
        name: z.string().max(80),
        level: z.enum(['info', 'warn', 'danger']),
      }),
    )
    .max(20),
});

/** Faits bruts normalisés : seule entrée du moteur. */
export const riskFactsSchema = z.object({
  version: z.literal(RISK_FACTS_VERSION),
  mint: mintAddressSchema,
  /** Horodatage de collecte : sert de « maintenant » au moteur (calcul des âges déterministe). */
  observedAt: z.iso.datetime(),
  mintAccount: mintAccountFactsSchema.nullable(),
  metadata: metadataFactsSchema.nullable(),
  liquidity: liquidityFactsSchema.nullable(),
  holders: holderFactsSchema.nullable(),
  sellSimulation: sellSimulationFactsSchema.nullable(),
  age: ageFactsSchema.nullable(),
  creator: creatorFactsSchema.nullable(),
  rugcheck: rugcheckFactsSchema.nullable(),
});
export type RiskFacts = z.infer<typeof riskFactsSchema>;

/**
 * Codes de raison produits par le moteur (stables : persistés, comptés par le banc).
 * Les phrases françaises correspondantes sont rédigées par le moteur / l'API et documentées
 * dans `docs/SCORING.md`. Toute nouvelle raison s'ajoute ici (via architect).
 */
export const RISK_REASON_CODES = [
  'MINT_AUTHORITY_ACTIVE',
  'FREEZE_AUTHORITY_ACTIVE',
  'FREEZE_AUTHORITY_KNOWN_ISSUER',
  'TOKEN2022_TRANSFER_FEE',
  'TOKEN2022_PERMANENT_DELEGATE',
  'TOKEN2022_TRANSFER_HOOK',
  'TOKEN2022_NON_TRANSFERABLE',
  'LIQUIDITY_REMOVED',
  'LIQUIDITY_LOW',
  'LP_NOT_BURNED_OR_LOCKED',
  'TOP10_CONCENTRATION_HIGH',
  'SINGLE_HOLDER_ABOVE_THRESHOLD',
  'SELL_NO_ROUTE',
  'SELL_TAX_HIGH',
  'SELL_PRICE_IMPACT_HIGH',
  'METADATA_MUTABLE',
  'TOKEN_VERY_NEW',
  'POOL_VERY_NEW',
  'CREATOR_PRIOR_RUGS',
  'CREATOR_MANY_DEAD_TOKENS',
  'RUGCHECK_RUGGED',
  'RUGCHECK_DANGER',
  'RUGCHECK_WARN',
  'DATA_UNAVAILABLE',
] as const;

export const riskReasonCodeSchema = z.enum(RISK_REASON_CODES);
export type RiskReasonCode = z.infer<typeof riskReasonCodeSchema>;

export const riskReasonSchema = z.object({
  checkId: analysisCheckIdSchema,
  code: riskReasonCodeSchema,
  status: checkStatusSchema,
  /** Raison critique : à elle seule, elle donne le verdict Danger. */
  critical: z.boolean(),
});
export type RiskReason = z.infer<typeof riskReasonSchema>;

export const riskCheckOutcomeSchema = z.object({
  id: analysisCheckIdSchema,
  status: checkStatusSchema,
  reasonCodes: z.array(riskReasonCodeSchema).max(8),
});
export type RiskCheckOutcome = z.infer<typeof riskCheckOutcomeSchema>;

/** Sortie du moteur : verdict, raisons et statut de chacun des 9 contrôles. */
export const riskAssessmentSchema = z.object({
  engineVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  verdict: verdictSchema,
  reasons: z.array(riskReasonSchema).max(40),
  checks: z.array(riskCheckOutcomeSchema).length(9),
});
export type RiskAssessment = z.infer<typeof riskAssessmentSchema>;
