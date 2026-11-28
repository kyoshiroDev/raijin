import type { WatchAnalysis } from '@raijin/api-analysis';
import type { SolanaDataService } from '@raijin/api-solana';

/**
 * Collecte des passes de suivi : `SolanaDataService` de `@raijin/api-solana` (voie de crédits
 * `watch`, ne lève pas), fourni par `ApiAnalysisModule` (`WATCH_SOLANA_DATA`).
 */
export type WatchSources = Pick<SolanaDataService, 'collectAuthoritiesBatch' | 'collectPoolsBatch' | 'collectHolders'>;
export const WATCH_SOURCES = Symbol('WATCH_SOURCES');

/** Passe complète (verdict) : pipeline d'analyse existant, sans quota utilisateur. */
export abstract class WatchAnalyzer {
  abstract analyzeForWatch(mint: string): Promise<WatchAnalysis>;
}
