import { DexScreenerClient } from './clients/dexscreener';
import { GeckoTerminalClient } from './clients/geckoterminal';
import { HeliusDasClient } from './clients/helius-das';
import type { JsonRpcTransport } from './clients/json-rpc';
import { JupiterQuoteClient } from './clients/jupiter';
import type { RestTransport } from './clients/rest';
import { RugCheckClient } from './clients/rugcheck';
import { SolanaRpcClient } from './clients/solana-rpc';
import { FactsCollector, type CollectOptions, type CollectedFacts } from './collect/facts-collector';
import {
  WatchCollector,
  type AuthoritiesBatchEntry,
  type CollectHoldersOptions,
  type PoolsBatchEntry,
} from './collect/watch-collector';
import type { HoldersSnapshot } from '@raijin/shared-contracts';
import { resolveSolanaDataConfig, type SolanaDataConfig, type SolanaDataConfigInput } from './config';
import type { UpstreamId } from './core/errors';
import { MemoryCacheStore, MemoryCreditBudget } from './core/memory';
import { SILENT_LOGGER, SYSTEM_CLOCK, type CacheStore, type Clock, type CreditBudget, type FetchLike, type SolanaLogger } from './core/ports';
import { UpstreamGate } from './core/upstream-gate';
import { isSolanaAddress } from '@raijin/shared-util';
import { QUOTE_MINTS } from './known-accounts';

export interface SolanaDataOptions {
  /** Configuration partielle (valeurs par défaut : `DEFAULT_SOLANA_DATA_CONFIG`). */
  readonly config?: SolanaDataConfigInput;
  /** Clé Helius, ou `null` : RPC public à 1 req/s et contrôles Helius « indisponible ». */
  readonly heliusApiKey?: string | null;
  readonly fetch?: FetchLike;
  readonly cache?: CacheStore;
  readonly creditBudget?: CreditBudget;
  readonly clock?: Clock;
  readonly logger?: SolanaLogger;
  /** Aléa de la gigue des rejeux (tests). */
  readonly random?: () => number;
}

export interface ResolvedToken {
  readonly mint: string;
  /** Vrai si l'adresse saisie était une paire DexScreener, résolue vers le mint du token. */
  readonly resolvedFromPair: boolean;
}

/**
 * Point d'entrée des intégrations Solana (utilisable sans Nest : API, banc, scripts).
 * Lecture seule : aucune transaction n'est construite, signée ni envoyée.
 */
export class SolanaDataService {
  readonly config: SolanaDataConfig;
  private readonly collector: FactsCollector;
  /** Même collecteur, crédits sur la voie `watch` (passe complète des suivis). */
  private readonly watchFactsCollector: FactsCollector;
  private readonly watchCollector: WatchCollector;
  private readonly dexscreener: DexScreenerClient;
  private readonly gates: ReadonlyMap<UpstreamId, UpstreamGate>;
  private readonly heliusKey: string | null;

  constructor(options: SolanaDataOptions = {}) {
    const config = resolveSolanaDataConfig(options.config);
    this.config = config;
    const clock = options.clock ?? SYSTEM_CLOCK;
    const logger = options.logger ?? SILENT_LOGGER;
    const fetchFn: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
    const budget =
      options.creditBudget ?? new MemoryCreditBudget(config.heliusDailyCreditBudget, clock, { watch: config.watchDailyCreditBudget });
    const cache = options.cache ?? new MemoryCacheStore(clock);
    // Clé gardée dans une propriété privée, utilisée uniquement pour construire l'URL au moment de l'appel.
    this.heliusKey = options.heliusApiKey ?? null;

    const gates = new Map<UpstreamId, UpstreamGate>();
    const gate = (source: UpstreamId) => {
      const existing = gates.get(source);
      if (existing) return existing;
      const created = new UpstreamGate(
        {
          source,
          ratePerSecond: config.limits[source].ratePerSecond,
          maxQueue: config.limits[source].maxQueue,
          maxAttempts: config.maxAttempts,
          backoffBaseMs: config.backoffBaseMs,
          maxRetryAfterMs: config.maxRetryAfterMs,
          breakerThreshold: config.breakerThreshold,
          breakerCooldownMs: config.breakerCooldownMs,
        },
        { clock, random: options.random },
      );
      gates.set(source, created);
      return created;
    };
    this.gates = gates;

    const rpcTransport = (source: 'helius_rpc' | 'helius_das' | 'solana_rpc', url: () => string): JsonRpcTransport => ({
      source,
      url,
      gate: gate(source),
      fetch: fetchFn,
      timeoutMs: config.limits[source].timeoutMs,
      maxBytes: config.maxResponseBytes,
      logger,
    });
    const rest = (source: UpstreamId, baseUrl: string): RestTransport => ({
      source,
      baseUrl,
      gate: gate(source),
      fetch: fetchFn,
      timeoutMs: config.limits[source].timeoutMs,
      maxBytes: config.maxResponseBytes,
      logger,
    });

    const heliusUrl = () => `${config.heliusRpcBaseUrl}/?api-key=${encodeURIComponent(this.heliusKey ?? '')}`;
    const rpc = new SolanaRpcClient(
      this.heliusKey === null ? null : { id: 'helius', transport: rpcTransport('helius_rpc', heliusUrl) },
      { id: 'solana_rpc', transport: rpcTransport('solana_rpc', () => config.publicRpcUrl) },
      budget,
      logger,
    );
    const das = new HeliusDasClient(this.heliusKey === null ? null : rpcTransport('helius_das', heliusUrl), budget);
    this.dexscreener = new DexScreenerClient(rest('dexscreener', config.dexscreenerBaseUrl));

    const collectorDeps = {
      config,
      rpc,
      das,
      dexscreener: this.dexscreener,
      geckoterminal: new GeckoTerminalClient(rest('geckoterminal', config.geckoterminalBaseUrl)),
      jupiter: new JupiterQuoteClient(rest('jupiter', config.jupiterBaseUrl), config.sellSlippageBps),
      rugcheck: new RugCheckClient(rest('rugcheck', config.rugcheckBaseUrl)),
      cache,
      clock,
      logger,
    };
    this.collector = new FactsCollector(collectorDeps);
    const watchRpc = rpc.withLane('watch');
    this.watchFactsCollector = new FactsCollector({ ...collectorDeps, rpc: watchRpc, das: das.withLane('watch') });
    this.watchCollector = new WatchCollector({ config, rpc: watchRpc, dexscreener: this.dexscreener, cache, clock, logger });
  }

  /** Vrai si une clé Helius est configurée (l'API allonge son cache à 300 s sinon). */
  get heliusConfigured(): boolean {
    return this.heliusKey !== null;
  }

  /** État des disjoncteurs par source (supervision, page admin). */
  breakerStates(): Record<string, string> {
    return Object.fromEntries([...this.gates.entries()].map(([id, gate]) => [id, gate.breakerState]));
  }

  /**
   * Faits normalisés d'un mint (validé en amont par `mintAddressSchema`). Lève `TokenNotFoundError`
   * (mint inexistant) ou `TokenUnanalyzableError` (compte de plus de 2 Mo). `lane: 'watch'` pour la
   * passe complète d'un suivi.
   */
  collectFacts(mint: string, options: CollectOptions = { profile: 'full' }): Promise<CollectedFacts> {
    return (options.lane === 'watch' ? this.watchFactsCollector : this.collector).collect(mint, options);
  }

  /**
   * Passe rapide des suivis : autorités mint / freeze par lots de 100 (1 crédit le lot, voie `watch`).
   * Ne lève pas : chaque mint est `ok`, `not_found`, `unanalyzable` ou `unavailable`.
   */
  collectAuthoritiesBatch(mints: readonly string[]): Promise<AuthoritiesBatchEntry[]> {
    return this.watchCollector.collectAuthoritiesBatch(mints);
  }

  /**
   * Passe rapide des suivis : pool principal (et pool déjà suivi, `trackedPools[mint]`) par lots
   * de 30, DexScreener (gratuit). Ne lève pas : `pool: null` = indisponible.
   */
  collectPoolsBatch(mints: readonly string[], trackedPools?: Readonly<Record<string, string | null | undefined>>): Promise<PoolsBatchEntry[]> {
    return this.watchCollector.collectPoolsBatch(mints, trackedPools);
  }

  /** Passe holders d'un mint (top 20, voie `watch`). `null` = indisponible (ou pas de clé Helius). */
  collectHolders(mint: string, options?: CollectHoldersOptions): Promise<HoldersSnapshot | null> {
    return this.watchCollector.collectHolders(mint, options);
  }

  /**
   * Adresse ambiguë (`kind: 'pair_or_mint'` de `extractSolanaAddress`) : si DexScreener la connaît
   * comme paire, renvoie le mint du token (côté non « monnaie de cotation »). Sinon, ou si
   * DexScreener est indisponible, l'adresse est traitée comme un mint.
   */
  async resolveToken(address: string): Promise<ResolvedToken> {
    try {
      const pair = await this.dexscreener.getPair(address);
      if (pair === null) return { mint: address, resolvedFromPair: false };
      const base = pair.baseToken.address;
      const quote = pair.quoteToken.address;
      const mint = QUOTE_MINTS.has(base) && !QUOTE_MINTS.has(quote) ? quote : base;
      // Donnée externe : le mint résolu doit être une vraie clé publique base58 (32 octets).
      if (!isSolanaAddress(mint)) return { mint: address, resolvedFromPair: false };
      return { mint, resolvedFromPair: true };
    } catch {
      return { mint: address, resolvedFromPair: false };
    }
  }
}
