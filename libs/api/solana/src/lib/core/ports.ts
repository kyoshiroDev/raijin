/**
 * Ports implémentés par l'hôte (API Raijin : Redis ; banc : sa propre implémentation).
 * La lib ne dépend ni de Redis ni de Prisma (ARCHITECTURE.md §9.1).
 */

/** `fetch` injecté : tests sans réseau, rejeu des fixtures. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Cache clé → chaîne JSON avec durée de vie. */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Horloge (millisecondes epoch). */
export interface Clock {
  now(): number;
}

/** Budget journalier de crédits Helius (compté dans Redis par l'API, en mémoire par défaut). */
export interface CreditBudget {
  /** Réserve `credits` ; `false` si le budget du jour est épuisé (repli RPC public ou « indisponible »). */
  tryConsume(credits: number): Promise<boolean>;
}

/** Valeurs journalisables : jamais d'URL, d'en-tête ni de clé (source, méthode, statut, latence). */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface SolanaLogger {
  debug(event: string, fields: LogFields): void;
  warn(event: string, fields: LogFields): void;
}

export const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export const SILENT_LOGGER: SolanaLogger = {
  debug: () => undefined,
  warn: () => undefined,
};
