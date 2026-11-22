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

/**
 * Voie de crédits (ARCHITECTURE.md §11.4) : `interactive` = analyses à la demande ; `watch` = passes
 * de suivi (plafond propre `WATCH_DAILY_CREDIT_BUDGET`, compté aussi dans le budget global).
 */
export type CreditLane = 'interactive' | 'watch';
export const CREDIT_LANES: readonly CreditLane[] = ['interactive', 'watch'];

/** Budget journalier de crédits Helius (compté dans Redis par l'API, en mémoire par défaut). */
export interface CreditBudget {
  /**
   * Réserve `credits` sur la voie `lane` (appelé à **chaque tentative** d'appel Helius, rejeux
   * compris) ; `false` si le budget du jour (global ou de la voie) est épuisé : repli RPC public
   * ou contrôle « indisponible », jamais d'erreur.
   */
  tryConsume(credits: number, lane: CreditLane): Promise<boolean>;
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
