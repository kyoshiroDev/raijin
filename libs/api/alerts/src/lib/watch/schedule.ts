import { createHash } from 'node:crypto';

/** Décalage stable d'un mint dans un intervalle (étalement des passes, docs/ARCHITECTURE.md §11.4). */
export function spreadOffsetMs(mint: string, intervalMs: number, salt = ''): number {
  if (intervalMs <= 0) return 0;
  const hash = createHash('sha256').update(`${salt}:${mint}`).digest();
  return hash.readUInt32BE(0) % intervalMs;
}

/** Coûts Helius estimés par passe (RPC 1 crédit, DAS 10), §11.4. */
export const PASS_CREDITS = {
  /** `getMultipleAccounts` jsonParsed : 1 crédit par lot de 100 mints (DexScreener gratuit). */
  fastPerBatch: 1,
  /** `getTokenLargestAccounts` + propriétaires et programmes en cache 24 h. */
  holders: 1.2,
  /** `collectFacts(full)` (cache d'âge 24 h). */
  full: 15,
} as const;

export const FAST_BATCH_SIZE = 100;
const DAY_MS = 86_400_000;

export interface BudgetInput {
  /** Mints suivis (au moins un suivi actif). */
  readonly mints: number;
  readonly fastIntervalMin: number;
  readonly holdersIntervalMin: number;
  readonly fullIntervalMin: number;
  /** Crédits restants aujourd'hui sur la voie `watch`. */
  readonly remainingCredits: number;
  /** Instant courant (pour la part de journée restante, UTC). */
  readonly now: Date;
}

/**
 * Facteur d'étirement `f = demande estimée sur le reste de la journée / budget restant` (≥ 1) :
 * les intervalles holders et complète sont multipliés par `f` ; la passe rapide (quasi gratuite)
 * reste à sa cadence. Budget épuisé : `Infinity` (passes reportées au lendemain).
 */
export function stretchFactor(input: BudgetInput): number {
  if (input.mints === 0) return 1;
  if (input.remainingCredits <= 0) return Number.POSITIVE_INFINITY;
  const perDay = (intervalMin: number) => (24 * 60) / intervalMin;
  const demandPerDay =
    input.mints * (perDay(input.holdersIntervalMin) * PASS_CREDITS.holders + perDay(input.fullIntervalMin) * PASS_CREDITS.full) +
    perDay(input.fastIntervalMin) * Math.ceil(input.mints / FAST_BATCH_SIZE) * PASS_CREDITS.fastPerBatch;
  const startOfDay = Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate());
  const leftFraction = Math.max(0.01, (startOfDay + DAY_MS - input.now.getTime()) / DAY_MS);
  return Math.max(1, (demandPerDay * leftFraction) / input.remainingCredits);
}

/** Début du lendemain UTC + décalage du mint (report quand le budget du jour est épuisé). */
export function tomorrowWithSpread(now: Date, mint: string, spreadMs: number): Date {
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return new Date(tomorrow + spreadOffsetMs(mint, spreadMs, 'tomorrow'));
}
