import type { AuthoritiesSnapshot, HoldersSnapshot, PoolSnapshot } from '@raijin/shared-contracts';
import { isSolanaAddress } from '@raijin/shared-util';
import type { DexPair, DexScreenerClient } from '../clients/dexscreener';
import { DEXSCREENER_BATCH_MAX } from '../clients/dexscreener';
import type { ParsedMint, SolanaRpcClient } from '../clients/solana-rpc';
import type { SolanaDataConfig } from '../config';
import { UpstreamError, type UpstreamErrorKind } from '../core/errors';
import type { CacheStore, Clock, SolanaLogger } from '../core/ports';
import { KNOWN_AMM_PROGRAMS, KNOWN_EXCLUDED_OWNERS } from '../known-accounts';
import { buildMintAccountFacts, shareOf } from './builders';

/** Taille maximale d'un lot `getMultipleAccounts` (doc Helius / Solana : 100 comptes). */
export const RPC_BATCH_MAX = 100;
/** Nombre de comptes lus par `getTokenLargestAccounts` (top 20). */
const HOLDERS_TOP = 20;
const U64_MAX_DIGITS = 20;

/** Résultat de la passe rapide (autorités) pour un mint. */
export type AuthoritiesBatchEntry =
  | {
      readonly mint: string;
      readonly status: 'ok';
      readonly authorities: AuthoritiesSnapshot;
      /** Offre brute (u64 en texte) : réutilisée par `collectHolders` sans appel de plus. */
      readonly supply: string;
      readonly decimals: number;
      readonly tokenProgram: ParsedMint['program'];
    }
  /** Le compte n'existe plus ou n'est pas un mint. */
  | { readonly mint: string; readonly status: 'not_found' }
  /** Compte de plus de 2 Mo (`TOKEN_UNANALYZABLE`) : à marquer `unanalyzable`, plus de passe rapide. */
  | { readonly mint: string; readonly status: 'unanalyzable' }
  /** Source indisponible : groupe `null`, aucune comparaison (jamais de fausse alerte). */
  | { readonly mint: string; readonly status: 'unavailable'; readonly errorKind: UpstreamErrorKind };

/** Lecture d'un pool (sans référence : `mergeWatchSnapshot` calcule `peakSqrtK` / `peakAt`). */
export type WatchPoolReading = Omit<PoolSnapshot, 'peakSqrtK' | 'peakAt'>;

/** Compatible avec `PoolObservation` de `@raijin/shared-risk-engine`. */
export interface WatchPoolObservation {
  /** Pool principal du moment (plus forte liquidité USD) ; `null` = aucun pool listé avec réserves. */
  readonly main: WatchPoolReading | null;
  /** Pool déjà suivi relu par son adresse s'il diffère du principal ; `null` = plus listé. */
  readonly tracked?: WatchPoolReading | null;
}

export interface PoolsBatchEntry {
  readonly mint: string;
  /** `null` = DexScreener indisponible pour ce mint (groupe conservé, aucune comparaison). */
  readonly pool: WatchPoolObservation | null;
}

export interface CollectHoldersOptions {
  /** Offre brute connue (passe rapide) : évite une lecture du mint. */
  readonly supply?: string;
  /** Adresses à exclure en plus des comptes connus (pool suivi, coffres du pool) : propriétaire ou compte. */
  readonly excludeAddresses?: readonly string[];
}

export interface WatchCollectorDeps {
  readonly config: SolanaDataConfig;
  /** Client RPC sur la voie `watch`. */
  readonly rpc: SolanaRpcClient;
  readonly dexscreener: DexScreenerClient;
  readonly cache: CacheStore;
  readonly clock: Clock;
  readonly logger: SolanaLogger;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function kindOf(error: unknown): UpstreamErrorKind {
  return error instanceof UpstreamError ? error.kind : 'network';
}

/** Identifiant de DEX externe réduit à `[a-z0-9_-]{1,32}` (contrat `poolSnapshotSchema`). */
export function sanitizeDexId(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
  return cleaned === '' ? 'unknown' : cleaned;
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Paire → lecture orientée (base = token suivi). `null` sans réserves exploitables. */
export function poolReading(pair: DexPair, mint: string, observedAt: string): WatchPoolReading | null {
  const isBase = pair.baseToken.address === mint;
  if (!isBase && pair.quoteToken.address !== mint) return null;
  const pairBase = finiteNonNegative(pair.liquidity?.base);
  const pairQuote = finiteNonNegative(pair.liquidity?.quote);
  if (pairBase === null || pairQuote === null) return null;
  const base = isBase ? pairBase : pairQuote;
  const quote = isBase ? pairQuote : pairBase;
  const sqrtK = Math.sqrt(base * quote);
  if (!Number.isFinite(sqrtK)) return null;
  return {
    address: pair.pairAddress,
    dex: sanitizeDexId(pair.dexId),
    base,
    quote,
    sqrtK,
    liquidityUsd: finiteNonNegative(pair.liquidity?.usd),
    observedAt,
  };
}

/**
 * Collecte légère des passes de suivi (ARCHITECTURE.md §11.4) : autorités par lots de 100
 * (1 crédit le lot), pools par lots de 30 (DexScreener, gratuit), top 20 holders (≈ 1,2 crédit
 * avec le cache des propriétaires). Toute panne donne un groupe « indisponible », jamais une erreur.
 * Lecture seule : aucune transaction.
 */
export class WatchCollector {
  constructor(private readonly deps: WatchCollectorDeps) {}

  private nowIso(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }

  private deadline(): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.config.collectDeadlineMs);
    (timer as { unref?: () => void }).unref?.();
    return { signal: controller.signal, done: () => clearTimeout(timer) };
  }

  // --- Autorités ---------------------------------------------------------------------------------

  /**
   * Autorités mint / freeze de chaque mint (`getMultipleAccounts` jsonParsed, lots de 100).
   * Réponse de plus de 2 Mo : lot coupé en deux jusqu'au mint fautif, marqué `unanalyzable`.
   * Ordre de sortie = ordre d'entrée (doublons retirés).
   */
  async collectAuthoritiesBatch(mints: readonly string[]): Promise<AuthoritiesBatchEntry[]> {
    const unique = [...new Set(mints)];
    const results: AuthoritiesBatchEntry[] = [];
    for (const chunk of chunks(unique, RPC_BATCH_MAX)) {
      const { signal, done } = this.deadline();
      try {
        results.push(...(await this.authoritiesChunk(chunk, signal)));
      } finally {
        done();
      }
    }
    return results;
  }

  private async authoritiesChunk(mints: readonly string[], signal: AbortSignal): Promise<AuthoritiesBatchEntry[]> {
    try {
      const { value } = await this.deps.rpc.getMints(mints, signal);
      const observedAt = this.nowIso();
      return mints.map((mint, index): AuthoritiesBatchEntry => {
        const parsed = value[index] ?? null;
        if (parsed === null) return { mint, status: 'not_found' };
        const facts = buildMintAccountFacts(parsed);
        return {
          mint,
          status: 'ok',
          authorities: { mintAuthorityActive: facts.mintAuthorityActive, freezeAuthorityActive: facts.freezeAuthorityActive, observedAt },
          supply: parsed.supply,
          decimals: parsed.decimals,
          tokenProgram: parsed.program,
        };
      });
    } catch (error) {
      if (error instanceof UpstreamError && error.kind === 'too_large' && !signal.aborted) {
        if (mints.length === 1) return [{ mint: mints[0] as string, status: 'unanalyzable' }];
        const middle = Math.ceil(mints.length / 2);
        const left = await this.authoritiesChunk(mints.slice(0, middle), signal);
        const right = await this.authoritiesChunk(mints.slice(middle), signal);
        return [...left, ...right];
      }
      const errorKind = kindOf(error);
      this.deps.logger.warn('watch_authorities_unavailable', { mints: mints.length, kind: errorKind });
      return mints.map((mint) => ({ mint, status: 'unavailable', errorKind }));
    }
  }

  // --- Pools -------------------------------------------------------------------------------------

  /**
   * Pool principal de chaque mint (DexScreener `tokens/v1`, lots de 30) et relecture du pool déjà
   * suivi (`trackedPools[mint]`, `latest/dex/pairs`, lots de 30) quand il n'est plus le principal.
   * Échec d'un appel : `pool: null` pour les mints concernés.
   */
  async collectPoolsBatch(
    mints: readonly string[],
    trackedPools: Readonly<Record<string, string | null | undefined>> = {},
  ): Promise<PoolsBatchEntry[]> {
    const unique = [...new Set(mints)];
    const observations = new Map<string, WatchPoolObservation | null>();
    const { signal, done } = this.deadline();
    try {
      for (const chunk of chunks(unique, DEXSCREENER_BATCH_MAX)) {
        let pairs: DexPair[];
        try {
          pairs = await this.deps.dexscreener.getTokensPairs(chunk, signal);
        } catch (error) {
          this.deps.logger.warn('watch_pools_unavailable', { mints: chunk.length, kind: kindOf(error) });
          for (const mint of chunk) observations.set(mint, null);
          continue;
        }
        const observedAt = this.nowIso();
        for (const mint of chunk) {
          const readings = pairs
            .map((pair) => poolReading(pair, mint, observedAt))
            .filter((reading): reading is WatchPoolReading => reading !== null)
            .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
          observations.set(mint, { main: readings[0] ?? null });
        }
      }

      // Pools suivis qui ne sont plus le principal : relus par adresse.
      const toRead = new Map<string, string>();
      for (const mint of unique) {
        const tracked = trackedPools[mint];
        const observation = observations.get(mint);
        if (tracked === null || tracked === undefined || !isSolanaAddress(tracked) || observation === null || observation === undefined) continue;
        if (observation.main?.address !== tracked) toRead.set(mint, tracked);
      }
      const entries = [...toRead.entries()];
      for (const chunk of chunks(entries, DEXSCREENER_BATCH_MAX)) {
        let pairs: DexPair[];
        try {
          pairs = await this.deps.dexscreener.getPairs([...new Set(chunk.map(([, address]) => address))], signal);
        } catch (error) {
          this.deps.logger.warn('watch_tracked_pools_unavailable', { pools: chunk.length, kind: kindOf(error) });
          for (const [mint] of chunk) observations.set(mint, null);
          continue;
        }
        const observedAt = this.nowIso();
        for (const [mint, address] of chunk) {
          const pair = pairs.find((candidate) => candidate.pairAddress === address);
          const tracked = pair === undefined ? null : poolReading(pair, mint, observedAt);
          const observation = observations.get(mint) as WatchPoolObservation;
          observations.set(mint, { main: observation.main, tracked });
        }
      }
    } finally {
      done();
    }
    return unique.map((mint) => ({ mint, pool: observations.get(mint) ?? null }));
  }

  // --- Holders -----------------------------------------------------------------------------------

  /**
   * Top 20 holders (`getTokenLargestAccounts`), mêmes exclusions que la concentration (pools,
   * autorités connues, comptes détenus par un programme AMM). Propriétaires et programmes en cache
   * (24 h par défaut). Sans clé Helius (le RPC public refuse cet appel) ou en cas d'échec : `null`.
   */
  async collectHolders(mint: string, options: CollectHoldersOptions = {}): Promise<HoldersSnapshot | null> {
    if (!this.deps.rpc.heliusConfigured) return null;
    const { signal, done } = this.deadline();
    try {
      let supply = options.supply;
      if (supply === undefined) {
        const mintResult = await this.deps.rpc.getMint(mint, signal);
        if (mintResult.value === null) return null;
        supply = mintResult.value.supply;
      }
      if (!/^\d{1,20}$/.test(supply)) return null;
      const supplyValue = BigInt(supply);
      const observedAt = this.nowIso();
      if (supplyValue === 0n) return { supply, top: [], observedAt };

      const largest = (await this.deps.rpc.getTokenLargestAccounts(mint, signal)).value
        .filter((entry) => entry.amount.length <= U64_MAX_DIGITS && isSolanaAddress(entry.address))
        .slice(0, HOLDERS_TOP);
      const owners = await this.owners(largest.map((entry) => entry.address), signal);
      const uniqueOwners = [...new Set(owners.values())];
      const programs = await this.programs(uniqueOwners, signal);

      const excluded = new Set([...Object.keys(KNOWN_EXCLUDED_OWNERS), ...(options.excludeAddresses ?? [])]);
      const top = largest
        .map((entry) => ({ tokenAccount: entry.address, owner: owners.get(entry.address) ?? entry.address, amount: entry.amount }))
        .filter((entry) => {
          if (excluded.has(entry.owner) || excluded.has(entry.tokenAccount)) return false;
          const program = programs.get(entry.owner);
          return !(program !== null && program !== undefined && program in KNOWN_AMM_PROGRAMS);
        })
        .map((entry) => ({ ...entry, pct: Math.min(100, shareOf(BigInt(entry.amount), supplyValue)) }));
      return { supply, top, observedAt };
    } catch (error) {
      this.deps.logger.warn('watch_holders_unavailable', { kind: kindOf(error) });
      return null;
    } finally {
      done();
    }
  }

  /** Propriétaire de chaque compte de token (cache, puis `getMultipleAccounts` jsonParsed pour le reste). */
  private async owners(tokenAccounts: readonly string[], signal: AbortSignal): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const missing: string[] = [];
    for (const account of tokenAccounts) {
      const cached = await this.readCache(`solana:token-owner:${account}`);
      if (cached !== null && isSolanaAddress(cached)) result.set(account, cached);
      else missing.push(account);
    }
    if (missing.length > 0) {
      const { value } = await this.deps.rpc.getTokenAccountOwners(missing, signal);
      for (const [index, account] of missing.entries()) {
        const owner = value[index] ?? null;
        if (owner === null) continue;
        result.set(account, owner);
        await this.writeCache(`solana:token-owner:${account}`, owner);
      }
    }
    return result;
  }

  /** Programme propriétaire de chaque wallet (cache, puis `getMultipleAccounts` sans données). */
  private async programs(owners: readonly string[], signal: AbortSignal): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const missing: string[] = [];
    for (const owner of owners) {
      const cached = await this.readCache(`solana:account-program:${owner}`);
      if (cached === null) missing.push(owner);
      else result.set(owner, cached === '' || !isSolanaAddress(cached) ? null : cached);
    }
    if (missing.length > 0) {
      const { value } = await this.deps.rpc.getAccountPrograms(missing, signal);
      for (const [index, owner] of missing.entries()) {
        const program = value[index] ?? null;
        result.set(owner, program);
        // Compte inexistant mis en cache aussi (« ») : un wallet vide ne devient pas un programme.
        await this.writeCache(`solana:account-program:${owner}`, program ?? '');
      }
    }
    return result;
  }

  private async readCache(key: string): Promise<string | null> {
    try {
      const raw = await this.deps.cache.get(key);
      if (raw === null) return null;
      const value: unknown = JSON.parse(raw);
      return typeof value === 'string' ? value : null;
    } catch {
      this.deps.logger.warn('solana_cache_read_failed', { key: key.split(':').slice(0, 2).join(':') });
      return null;
    }
  }

  private async writeCache(key: string, value: string): Promise<void> {
    try {
      await this.deps.cache.set(key, JSON.stringify(value), this.deps.config.holderOwnersCacheTtlSeconds);
    } catch {
      this.deps.logger.warn('solana_cache_write_failed', { key: key.split(':').slice(0, 2).join(':') });
    }
  }
}
