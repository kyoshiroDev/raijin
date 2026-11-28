/**
 * Préfixe de **toutes** les clés Redis de l'API Raijin (docs/ARCHITECTURE.md §17.5) : l'ACL `raijin-api` est
 * limitée à `~raijin:*`, celle du banc à `~raijin-bench:*`. Appliqué au niveau de la connexion (`keyPrefix`
 * d'ioredis : commandes, `MULTI`, pipelines et `KEYS[]` des scripts Lua), jamais à la main dans les clés.
 * BullMQ n'accepte pas `keyPrefix` : ses connexions gardent leur propre préfixe (`BULLMQ_PREFIX=raijin`).
 * Les motifs `KEYS`/`SCAN` ne sont pas préfixés par ioredis : l'API n'en utilise pas.
 */
export const REDIS_KEY_PREFIX = 'raijin:' as const;

/** Options communes des connexions Redis de l'API : échec rapide et préfixe `raijin:`. */
export interface RaijinRedisOptions {
  readonly keyPrefix: typeof REDIS_KEY_PREFIX;
  readonly maxRetriesPerRequest: number;
  readonly enableOfflineQueue: boolean;
  readonly connectTimeout: number;
}

/** Connexion « échec rapide » (caches, compteurs, verrous) : une tentative, pas de file hors ligne, 2 s. */
export function raijinRedisOptions(): RaijinRedisOptions {
  return { keyPrefix: REDIS_KEY_PREFIX, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 };
}
