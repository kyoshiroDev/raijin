import * as z from '../zod';
import { mintAddressSchema, solanaAddressSchema } from '../address';
import { riskReasonCodeSchema } from '../analysis/risk';
import { verdictSchema } from '../verdict';

/**
 * Instantané comparable d'un mint suivi (docs/ARCHITECTURE.md §11.4) : produit par `api-solana`
 * (passes rapide, holders, complète), stocké une fois par mint (`MintWatchState.snapshot`) et comparé
 * par `detectWatchEvents` (`@raijin/shared-risk-engine`). Contrat serveur partagé avec le banc
 * (suivi des verdicts), jamais exposé au front.
 *
 * Chaque groupe porte son propre `observedAt` : les passes ne rafraîchissent pas toutes les mêmes
 * données au même rythme. Un groupe `null` = jamais observé ou indisponible (aucune comparaison).
 */
export const WATCH_SNAPSHOT_VERSION = 1;

/** Montant brut u64 en texte décimal (pas de perte de précision). */
const rawAmount = z.string().regex(/^\d{1,20}$/);
const pct = z.number().min(0).max(100);

export const authoritiesSnapshotSchema = z.object({
  mintAuthorityActive: z.boolean(),
  freezeAuthorityActive: z.boolean(),
  observedAt: z.iso.datetime(),
});

export const poolSnapshotSchema = z.object({
  /** Pool principal (plus forte liquidité USD, DexScreener). */
  address: solanaAddressSchema,
  dex: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  /** Réserves en unités de tokens (base = token suivi, quote = SOL/USDC…). */
  base: z.number().finite().min(0),
  quote: z.number().finite().min(0),
  /** √(base × quote) : ne baisse que si de la liquidité est retirée (insensible aux swaps). */
  sqrtK: z.number().finite().min(0),
  liquidityUsd: z.number().finite().min(0).nullable(),
  /** Plus haut de `sqrtK` sur la fenêtre de référence (`lpReferenceWindowHours`) et son instant. */
  peakSqrtK: z.number().finite().min(0),
  peakAt: z.iso.datetime(),
  observedAt: z.iso.datetime(),
});

export const holderSnapshotEntrySchema = z.object({
  owner: solanaAddressSchema,
  tokenAccount: solanaAddressSchema,
  amount: rawAmount,
  pct,
});

export const holdersSnapshotSchema = z.object({
  supply: rawAmount,
  /** Top 20 des comptes, LP et programmes connus exclus (mêmes exclusions que la concentration). */
  top: z.array(holderSnapshotEntrySchema).max(20),
  observedAt: z.iso.datetime(),
});

export const verdictSnapshotSchema = z.object({
  verdict: verdictSchema,
  engineVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  /** `TokenAnalysis.id` de la réanalyse complète. */
  analysisId: z.uuid().nullable(),
  reasonCodes: z.array(riskReasonCodeSchema).max(40),
  observedAt: z.iso.datetime(),
});

export const watchSnapshotSchema = z.object({
  version: z.literal(WATCH_SNAPSHOT_VERSION),
  mint: mintAddressSchema,
  authorities: authoritiesSnapshotSchema.nullable(),
  pool: poolSnapshotSchema.nullable(),
  holders: holdersSnapshotSchema.nullable(),
  verdict: verdictSnapshotSchema.nullable(),
});
export type WatchSnapshot = z.infer<typeof watchSnapshotSchema>;
export type AuthoritiesSnapshot = z.infer<typeof authoritiesSnapshotSchema>;
export type PoolSnapshot = z.infer<typeof poolSnapshotSchema>;
export type HoldersSnapshot = z.infer<typeof holdersSnapshotSchema>;
export type VerdictSnapshot = z.infer<typeof verdictSnapshotSchema>;
