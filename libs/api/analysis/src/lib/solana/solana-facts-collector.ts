import { Logger } from '@nestjs/common';
import { TokenNotFoundError, UpstreamError, type LogFields, type SolanaDataService, type SolanaLogger } from '@raijin/api-solana';
import {
  FactsCollector,
  isTokenUnanalyzable,
  TokenUnanalyzableError,
  UpstreamUnavailableError,
  type CollectedFacts,
  type CollectorOptions,
} from '../ports/facts-collector';

/**
 * Adaptateur du port `FactsCollector` sur `SolanaDataService` (`@raijin/api-solana`) :
 * `TokenNotFoundError` → `null` (404 `TOKEN_NOT_FOUND`) ; `UpstreamError` (lecture du mint impossible)
 * → `UpstreamUnavailableError` (503) ; compte hors normes (`TokenUnanalyzableError` de la lib, code
 * `TOKEN_UNANALYZABLE`) → `TokenUnanalyzableError` du port (422). Les autres pannes de source donnent des faits `null` et `degraded`.
 */
export class SolanaFactsCollector extends FactsCollector {
  constructor(private readonly solana: SolanaDataService) {
    super();
  }

  override get heliusConfigured(): boolean {
    return this.solana.heliusConfigured;
  }

  async collectFacts(mint: string, options: CollectorOptions): Promise<CollectedFacts | null> {
    try {
      const collected = await this.solana.collectFacts(mint, options);
      return {
        facts: collected.facts,
        token: {
          name: collected.token.name,
          symbol: collected.token.symbol,
          decimals: collected.token.decimals,
          tokenProgram: collected.token.tokenProgram,
        },
        sources: collected.sources.map((source) => ({
          source: source.id,
          status: source.status,
          latencyMs: source.latencyMs,
          errorKind: source.errorKind,
        })),
        checkSources: collected.checkSources,
        degraded: collected.degraded,
      };
    } catch (error) {
      if (error instanceof TokenNotFoundError) return null;
      if (isTokenUnanalyzable(error)) throw new TokenUnanalyzableError();
      // Lecture du mint impossible : 503 (remboursement plafonné, cache négatif), jamais un 500.
      if (error instanceof UpstreamError) throw new UpstreamUnavailableError();
      throw error;
    }
  }

  async resolveMint(address: string): Promise<string | null> {
    const resolved = await this.solana.resolveToken(address);
    return resolved.resolvedFromPair ? resolved.mint : null;
  }
}

/** Journal des sources : champs déjà sûrs (source, méthode, statut, latence ; jamais d'URL ni de clé). */
export class NestSolanaLogger implements SolanaLogger {
  private readonly logger = new Logger('Solana');

  debug(event: string, fields: LogFields): void {
    this.logger.debug(`${event} ${JSON.stringify(fields)}`);
  }

  warn(event: string, fields: LogFields): void {
    this.logger.warn(`${event} ${JSON.stringify(fields)}`);
  }
}
