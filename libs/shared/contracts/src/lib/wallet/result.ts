import * as z from '../zod';
import { mintAddressSchema, solanaAddressSchema, walletAddressSchema } from '../address';
import { ANALYSIS_CHECK_IDS } from '../analysis/checks';
import { quotaInfoSchema } from '../analysis/quota';
import { dataSourceIdSchema } from '../analysis/sources';
import { tokenMetadataSchema, tokenProgramSchema } from '../analysis/token';
import { verdictSchema } from '../verdict';

/**
 * Résultat d'un scan de wallet (PROMPT.md §4.3, docs/ARCHITECTURE.md §12).
 *
 * Routes (`/api/v1`, session obligatoire, CSRF sur la mutation) :
 * - `POST wallet-scans` (`WalletScanRequest`) → `WalletScanResponse` ; Gratuit → 403 `WALLET_SCAN_PLAN_REQUIRED` ;
 * - `GET wallet-scans/quota` → `WalletScanQuotaResponse`.
 * Aucune adresse de wallet n'est persistée en base (cache Redis court seulement).
 */

/** Bornes du contrat (les plafonds effectifs sont en configuration côté API, inférieurs ou égaux). */
export const WALLET_SCAN_MAX_ITEMS = 100;
export const WALLET_SCAN_MAX_DELEGATIONS = 100;

/** Montant de token : brut (u64 en chaîne décimale) et décimal exact (formatage compact côté front). */
export const tokenAmountSchema = z.object({
  /** Montant brut en plus petites unités (u64, chaîne décimale sans signe). */
  raw: z.string().regex(/^\d{1,20}$/),
  decimals: z.number().int().min(0).max(255),
  /** Montant décimal exact (`raw / 10^decimals`), ex. `"1234.5"` ; formaté par le front. */
  ui: z.string().max(300).regex(/^\d+(\.\d+)?$/),
});
export type TokenAmount = z.infer<typeof tokenAmountSchema>;

/** Profondeur du verdict : `full` (9 contrôles, analyse récente réutilisée) ou `light` (contrôle rapide). */
export const walletVerdictCoverageSchema = z.enum(['full', 'light']);
export type WalletVerdictCoverage = z.infer<typeof walletVerdictCoverageSchema>;

/** Motif d'absence d'analyse : au-delà du plafond de tokens analysés, ou valeur sous le seuil de poussière. */
export const walletNotAnalyzedReasonSchema = z.enum(['over_limit', 'dust']);
export type WalletNotAnalyzedReason = z.infer<typeof walletNotAnalyzedReasonSchema>;

/** Motif d'indisponibilité : source en panne, échéance du scan dépassée, budget Helius épuisé, compte non analysable. */
export const walletUnavailableReasonSchema = z.enum(['upstream', 'timeout', 'budget', 'unanalyzable']);
export type WalletUnavailableReason = z.infer<typeof walletUnavailableReasonSchema>;

/** Verdict (ou son absence) d'un token détenu. */
export const walletTokenAssessmentSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('analyzed'),
    verdict: verdictSchema,
    /** Phrase d'explication du verdict (texte Raijin). */
    explanation: z.string().min(1).max(280),
    coverage: walletVerdictCoverageSchema,
    /** Contrôles réellement évalués sur 9 (contrôle rapide : 6 au plus). */
    checksEvaluated: z.number().int().min(0).max(ANALYSIS_CHECK_IDS.length),
    /** Au moins une source attendue manquait. */
    degraded: z.boolean(),
    analyzedAt: z.iso.datetime(),
    /** Verdict repris du cache (analyse complète récente ou scan précédent). */
    fromCache: z.boolean(),
  }),
  z.object({ status: z.literal('not_analyzed'), reason: walletNotAnalyzedReasonSchema }),
  z.object({ status: z.literal('unavailable'), reason: walletUnavailableReasonSchema }),
]);
export type WalletTokenAssessment = z.infer<typeof walletTokenAssessmentSchema>;

/** Un token détenu (comptes de tokens d'un même mint agrégés). */
export const walletTokenSchema = z
  .object({
    mint: mintAddressSchema,
    tokenProgram: tokenProgramSchema,
    /** Nom et symbole **non fiables** (`untrusted: true`), nettoyés ; affichés comme tels. */
    token: tokenMetadataSchema,
    balance: tokenAmountSchema,
    /** Valeur indicative en USD (prix DexScreener), `null` si inconnue. Sert au tri. */
    valueUsd: z.number().finite().min(0).nullable(),
    /** Nombre de comptes de tokens agrégés pour ce mint. */
    accountCount: z.number().int().min(1).max(1000),
    /** Au moins un compte gelé par l'autorité de freeze du token. */
    frozen: z.boolean(),
    /** Au moins un compte porte une délégation active (détail dans `delegations`). */
    delegated: z.boolean(),
    assessment: walletTokenAssessmentSchema,
  })
  .refine((item) => item.token.mint === item.mint, { message: 'Mint incohérent.', path: ['token', 'mint'] });
export type WalletToken = z.infer<typeof walletTokenSchema>;

/**
 * Délégation active d'un compte de token (`delegate` + `delegatedAmount`, SPL et Token-2022), y
 * compris sur un compte vide (le délégué pourra agir si le compte est réalimenté). Le délégué
 * permanent Token-2022 (au niveau du mint, non révocable par le holder) n'est pas ici : il est
 * signalé par le verdict du token.
 */
export const walletDelegationSchema = z.object({
  tokenAccount: solanaAddressSchema,
  mint: mintAddressSchema,
  tokenProgram: tokenProgramSchema,
  /** Métadonnées non fiables du token, si connues. */
  token: tokenMetadataSchema.nullable(),
  delegate: solanaAddressSchema,
  delegatedAmount: tokenAmountSchema,
  /** Solde actuel du compte délégué. */
  balance: tokenAmountSchema,
  /** Le montant délégué couvre tout le solde actuel. */
  coversFullBalance: z.boolean(),
});
export type WalletDelegation = z.infer<typeof walletDelegationSchema>;

/** Répartition des verdicts des tokens analysés. */
export const walletVerdictCountsSchema = z.object({
  safe: z.number().int().min(0),
  warn: z.number().int().min(0),
  danger: z.number().int().min(0),
});
export type WalletVerdictCounts = z.infer<typeof walletVerdictCountsSchema>;

/** Résumé du scan (compté sur **tout** le wallet, avant les plafonds d'affichage). */
export const walletScanSummarySchema = z.object({
  /** Tokens fongibles détenus avec un solde non nul (mints distincts). */
  tokenCount: z.number().int().min(0),
  analyzedCount: z.number().int().min(0),
  verdicts: walletVerdictCountsSchema,
  unavailableCount: z.number().int().min(0),
  /** Au-delà du plafond de tokens analysés. */
  overLimitCount: z.number().int().min(0),
  /** Valeur sous le seuil de poussière (non analysés). */
  dustCount: z.number().int().min(0),
  /** Comptes probablement NFT (0 décimale, solde 1) : ignorés. */
  nftCount: z.number().int().min(0),
  /** Comptes de tokens vides (solde 0), hors délégations. */
  emptyAccountCount: z.number().int().min(0),
  delegationCount: z.number().int().min(0),
  /** Somme des valeurs connues, indicative ; `null` si aucune n'est connue. */
  totalValueUsd: z.number().finite().min(0).nullable(),
});
export type WalletScanSummary = z.infer<typeof walletScanSummarySchema>;

export const walletScanResultSchema = z
  .object({
    address: walletAddressSchema,
    summary: walletScanSummarySchema,
    /** Tokens triés par valeur décroissante (inconnue en dernier), au plus `WALLET_SCAN_MAX_ITEMS`. */
    tokens: z.array(walletTokenSchema).max(WALLET_SCAN_MAX_ITEMS),
    delegations: z.array(walletDelegationSchema).max(WALLET_SCAN_MAX_DELEGATIONS),
    /** Sources interrogées (comptes : `helius` ou `solana_rpc` ; prix : `dexscreener`). */
    sources: z.array(dataSourceIdSchema).max(6),
    engineVersion: z.string().min(1).max(32),
    scannedAt: z.iso.datetime(),
    /** Résultat servi depuis le cache du wallet. */
    cached: z.boolean(),
    /** Échéance ou budget atteints : certains tokens sont `unavailable`. */
    partial: z.boolean(),
  })
  .refine((scan) => scan.tokens.length <= scan.summary.tokenCount, {
    message: 'Plus de tokens listés que détenus.',
    path: ['tokens'],
  })
  .refine((scan) => scan.delegations.length <= scan.summary.delegationCount, {
    message: 'Délégations incohérentes.',
    path: ['delegations'],
  })
  .refine(
    (scan) =>
      scan.summary.verdicts.safe + scan.summary.verdicts.warn + scan.summary.verdicts.danger ===
      scan.summary.analyzedCount,
    { message: 'Répartition des verdicts incohérente.', path: ['summary', 'verdicts'] },
  );
export type WalletScanResult = z.infer<typeof walletScanResultSchema>;

/** Réponse de `POST wallet-scans` : résultat + quota de scans restant (`kind: wallet_scan`). */
export const walletScanResponseSchema = z.object({
  scan: walletScanResultSchema,
  quota: quotaInfoSchema.refine((quota) => quota.kind === 'wallet_scan', { message: 'Quota inattendu.' }),
});
export type WalletScanResponse = z.infer<typeof walletScanResponseSchema>;

/**
 * Réponse de `GET wallet-scans/quota` : `allowed: false` et `quota: null` en Gratuit (écran
 * d'explication, essai ou Pro proposés sans urgence) ; Pro et essai : quota du jour.
 */
export const walletScanQuotaResponseSchema = z
  .object({
    allowed: z.boolean(),
    quota: quotaInfoSchema.nullable(),
  })
  .refine((value) => (value.allowed ? value.quota?.kind === 'wallet_scan' : value.quota === null), {
    message: 'Quota de scan incohérent.',
    path: ['quota'],
  });
export type WalletScanQuotaResponse = z.infer<typeof walletScanQuotaResponseSchema>;
