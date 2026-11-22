import { Logger } from '@nestjs/common';
import { TokenNotFoundError, type LogFields, type SolanaDataService, type SolanaLogger } from '@raijin/api-solana';
import { FactsCollector, type CollectedFacts, type CollectorProfile } from '../ports/facts-collector';

/**
 * Adaptateur du port `FactsCollector` sur `SolanaDataService` (`@raijin/api-solana`) :
 * `TokenNotFoundError` → `null` (404 `TOKEN_NOT_FOUND`) ; une panne de source donne déjà des faits
 * `null` et `degraded` côté collecte, jamais une exception.
 */
export class SolanaFactsCollector extends FactsCollector {
  constructor(private readonly solana: SolanaDataService) {
    super();
  }

  override get heliusConfigured(): boolean {
    return this.solana.heliusConfigured;
  }

  async collectFacts(mint: string, options: { profile: CollectorProfile }): Promise<CollectedFacts | null> {
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
