import {
  ANALYSIS_CHECK_IDS,
  RISK_FACTS_VERSION,
  riskFactsSchema,
  tokenMetadataSchema,
  type AnalysisCheckId,
  type DataSourceId,
  type DataSourceRef,
  type RiskFacts,
  type TokenMetadata,
} from '@raijin/shared-contracts';
import { sanitizeUntrustedText } from '@raijin/shared-util';
import type { DexPair, DexScreenerClient } from '../clients/dexscreener';
import type { GeckoPool, GeckoTerminalClient } from '../clients/geckoterminal';
import type { DasAsset, HeliusDasClient } from '../clients/helius-das';
import type { JupiterQuoteClient } from '../clients/jupiter';
import type { RugCheckClient } from '../clients/rugcheck';
import type { ParsedMint, RpcCallResult, SolanaRpcClient } from '../clients/solana-rpc';
import type { SolanaDataConfig } from '../config';
import { TokenNotFoundError, TokenUnanalyzableError, UpstreamError, type UpstreamErrorKind } from '../core/errors';
import type { CacheStore, Clock, CreditLane, SolanaLogger } from '../core/ports';
import { KNOWN_AMM_PROGRAMS, KNOWN_EXCLUDED_OWNERS, USDC_MINT, WSOL_MINT } from '../known-accounts';
import { sourceRef } from '../source-links';
import {
  buildCreatorFacts,
  buildLiquidityFacts,
  buildMintAccountFacts,
  buildRugcheckFacts,
  concentration,
  mainPoolCreatedAt,
  poolAddresses,
  priceUsd,
  shareOf,
  toIsoDate,
  token2022Metadata,
  type HolderEntry,
} from './builders';
import { clampPct, digestRugCheckReport, type RugCheckDigest } from './rugcheck-digest';

/** `full` : analyse complète ; `light` : scan de wallet (sans devis, historique créateur, RugCheck ni GeckoTerminal). */
export type CollectProfile = 'full' | 'light';

export interface CollectOptions {
  readonly profile: CollectProfile;
  /**
   * Voie de crédits Helius (défaut `interactive`) : la passe complète d'un suivi utilise `watch`
   * (ARCHITECTURE.md §11.4).
   */
  readonly lane?: CreditLane;
}

export type SourceStatus = 'ok' | 'error' | 'skipped';

export interface SourceReport {
  readonly id: DataSourceId;
  readonly status: SourceStatus;
  readonly latencyMs: number | null;
  readonly errorKind: UpstreamErrorKind | null;
}

export interface CollectedFacts {
  readonly profile: CollectProfile;
  /** Faits normalisés (entrée du moteur, persistés pour le banc). */
  readonly facts: RiskFacts;
  /** Métadonnées non fiables, nettoyées (`untrusted: true`, aucune image). */
  readonly token: TokenMetadata;
  /** Sources citées par contrôle (au moins une, liens publics construits par Raijin). */
  readonly checkSources: Readonly<Record<AnalysisCheckId, readonly DataSourceRef[]>>;
  /** Statut par source (ok / erreur / ignorée, latence). */
  readonly sources: readonly SourceReport[];
  /** Vrai si un groupe de faits attendu pour le profil manque (résultat partiel). */
  readonly degraded: boolean;
}

export interface FactsCollectorDeps {
  readonly config: SolanaDataConfig;
  readonly rpc: SolanaRpcClient;
  readonly das: HeliusDasClient;
  readonly dexscreener: DexScreenerClient;
  readonly geckoterminal: GeckoTerminalClient;
  readonly jupiter: JupiterQuoteClient;
  readonly rugcheck: RugCheckClient;
  readonly cache: CacheStore;
  readonly clock: Clock;
  readonly logger: SolanaLogger;
}

/** Suivi des appels par source pour le rapport final. */
class SourceTracker {
  private readonly reports = new Map<DataSourceId, { status: SourceStatus; latencyMs: number | null; errorKind: UpstreamErrorKind | null }>();

  constructor(private readonly clock: Clock) {}

  skip(id: DataSourceId): void {
    if (!this.reports.has(id)) this.reports.set(id, { status: 'skipped', latencyMs: null, errorKind: null });
  }

  /** Appel déjà effectué hors suivi (lecture du mint). */
  markOk(id: DataSourceId, latencyMs: number): void {
    this.record(id, true, latencyMs, null);
  }

  private record(id: DataSourceId, ok: boolean, latencyMs: number, errorKind: UpstreamErrorKind | null): void {
    const previous = this.reports.get(id);
    if (previous?.status === 'error') {
      previous.latencyMs = Math.max(previous.latencyMs ?? 0, latencyMs);
      return;
    }
    this.reports.set(id, {
      status: ok ? 'ok' : 'error',
      latencyMs: Math.max(previous?.latencyMs ?? 0, latencyMs),
      errorKind,
    });
  }

  /** Exécute `task` ; toute erreur fournisseur devient `null` (contrôle « indisponible »). */
  async track<T>(id: DataSourceId | ((value: T) => DataSourceId), fallbackId: DataSourceId, task: () => Promise<T>): Promise<T | null> {
    const startedAt = this.clock.now();
    try {
      const value = await task();
      this.record(typeof id === 'function' ? id(value) : id, true, this.clock.now() - startedAt, null);
      return value;
    } catch (error) {
      if (error instanceof TokenNotFoundError) throw error;
      const kind = error instanceof UpstreamError ? error.kind : 'network';
      this.record(fallbackId, false, this.clock.now() - startedAt, kind);
      return null;
    }
  }

  list(): SourceReport[] {
    return [...this.reports.entries()].map(([id, report]) => ({ id, ...report }));
  }
}

function cleanName(value: unknown, max: number): string | null {
  const cleaned = sanitizeUntrustedText(typeof value === 'string' ? value : '', max);
  return cleaned === '' ? null : cleaned;
}

/**
 * Agrégateur des faits d'un mint (ARCHITECTURE.md §9.1) : appels parallèles sous une échéance
 * globale, chaque source en échec donnant un groupe `null` (contrôle « indisponible ») plutôt
 * qu'une erreur. Seul un mint inexistant lève `TokenNotFoundError` (compte de plus de 2 Mo :
 * `TokenUnanalyzableError`).
 */
export class FactsCollector {
  constructor(private readonly deps: FactsCollectorDeps) {}

  async collect(mint: string, options: CollectOptions): Promise<CollectedFacts> {
    const { config, clock } = this.deps;
    const full = options.profile === 'full';
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), config.collectDeadlineMs);
    (deadline as { unref?: () => void }).unref?.();
    const signal = controller.signal;
    const tracker = new SourceTracker(clock);
    const rpcFallback: DataSourceId = this.deps.rpc.heliusConfigured ? 'helius' : 'solana_rpc';
    const servedBy = <T>(result: RpcCallResult<T>): DataSourceId => result.servedBy;
    const nowMs = clock.now();

    try {
      // Coût d'abord : le compte de mint (1 crédit) est lu seul. Un mint introuvable ne déclenche
      // aucun autre appel (ni DAS à 10 crédits, ni signatures, ni sources tierces).
      // Sans compte de mint lisible, aucun verdict n'est possible (canIssueVerdict) : on s'arrête ici,
      // quelle que soit la cause, pour ne facturer aucun autre appel (analyse remboursée par l'API).
      let mintResult: RpcCallResult<ParsedMint | null>;
      const mintStartedAt = clock.now();
      try {
        mintResult = await this.deps.rpc.getMint(mint, signal);
      } catch (error) {
        if (error instanceof UpstreamError || error instanceof TokenUnanalyzableError) throw error;
        throw new UpstreamError(rpcFallback === 'helius' ? 'helius_rpc' : 'solana_rpc', 'network');
      }
      if (mintResult.value === null) throw new TokenNotFoundError();
      tracker.markOk(mintResult.servedBy, clock.now() - mintStartedAt);

      const dexPromise = tracker.track('dexscreener', 'dexscreener', () => this.deps.dexscreener.getTokenPairs(mint, signal));
      const geckoPromise = full
        ? tracker.track('geckoterminal', 'geckoterminal', () => this.deps.geckoterminal.getTokenPools(mint, signal))
        : Promise.resolve(null);
      const rugcheckPromise = full
        ? tracker.track('rugcheck', 'rugcheck', () => this.rugcheckDigest(mint, signal))
        : Promise.resolve(null);
      const dasPromise = this.deps.das.configured
        ? tracker.track('helius', 'helius', () => this.deps.das.getAsset(mint, signal))
        : Promise.resolve(null);
      const creationPromise = full
        ? tracker.track(servedBy, rpcFallback, () => this.tokenCreation(mint, signal))
        : Promise.resolve(null);

      const [dex, gecko, rugcheck, das, creation] = await Promise.all([
        dexPromise,
        geckoPromise,
        rugcheckPromise,
        dasPromise,
        creationPromise,
      ]);
      if (!full) {
        tracker.skip('geckoterminal');
        tracker.skip('rugcheck');
        tracker.skip('jupiter');
      }
      if (!this.deps.das.configured) tracker.skip('helius');

      const parsedMint: ParsedMint | null = mintResult.value;
      const mintAccount = parsedMint === null ? null : buildMintAccountFacts(parsedMint);
      const liquidity = buildLiquidityFacts(mint, dex, gecko, rugcheck, config.lpRemovedMaxUsd);
      const pools = poolAddresses(dex, gecko, rugcheck);

      const holdersResult = await this.holders(mint, parsedMint, pools, rugcheck, tracker, rpcFallback, signal);
      const sell = full && parsedMint !== null ? await this.sellSimulation(mint, parsedMint, dex, gecko, rugcheck, tracker, signal) : null;

      const metadata = this.metadata(das, parsedMint, rugcheck);
      const poolCreatedAt = mainPoolCreatedAt(mint, dex, gecko, nowMs);
      const age =
        creation === null && dex === null && gecko === null
          ? null
          : { tokenCreatedAt: creation?.value ?? null, poolCreatedAt };
      const creator = full ? await this.creator(mint, rugcheck, nowMs) : null;

      const facts = riskFactsSchema.parse({
        version: RISK_FACTS_VERSION,
        mint,
        observedAt: new Date(nowMs).toISOString(),
        mintAccount,
        metadata: metadata.value,
        liquidity,
        holders: holdersResult.value,
        sellSimulation: sell?.value ?? null,
        age,
        creator,
        rugcheck: buildRugcheckFacts(rugcheck),
      } satisfies RiskFacts);

      const token = tokenMetadataSchema.parse({
        mint,
        name: this.tokenName(mint, das, parsedMint, dex, rugcheck, 'name'),
        symbol: this.tokenName(mint, das, parsedMint, dex, rugcheck, 'symbol'),
        decimals: parsedMint?.decimals ?? null,
        tokenProgram: parsedMint?.program ?? null,
        untrusted: true,
      });

      const rpcSource: DataSourceId = mintResult.servedBy;
      const checkSources = this.checkSources(mint, {
        rpc: rpcSource,
        holders: holdersResult.source ?? rpcSource,
        metadata: metadata.source,
        lpFromRugcheck: liquidity?.lpBurnedOrLockedPct !== null && rugcheck !== null,
        light: !full,
      });

      const expected: Array<keyof RiskFacts> = ['mintAccount', 'metadata', 'liquidity', 'holders', 'age'];
      if (full) expected.push('sellSimulation', 'creator', 'rugcheck');
      const degraded = expected.some((key) => facts[key] === null);

      return { profile: options.profile, facts, token, checkSources, sources: tracker.list(), degraded };
    } finally {
      clearTimeout(deadline);
    }
  }

  /** Rapport RugCheck condensé, mis en cache (5 min par défaut). */
  private async rugcheckDigest(mint: string, signal: AbortSignal): Promise<RugCheckDigest | null> {
    const key = `solana:rugcheck:${mint}`;
    const cached = await this.readCache<RugCheckDigest>(key);
    if (cached !== null) return cached;
    const report = await this.deps.rugcheck.getReport(mint, signal);
    const digest = report === null ? null : digestRugCheckReport(report);
    if (digest !== null) await this.writeCache(key, digest, this.deps.config.cacheTtlSeconds.rugcheck);
    return digest;
  }

  /**
   * Date de création du token : plus ancienne signature du compte de mint, si l'historique tient
   * dans `maxSignaturePages` pages. Sinon `null` (l'âge du pool prend le relais). Cache 24 h.
   */
  private async tokenCreation(mint: string, signal: AbortSignal): Promise<RpcCallResult<string | null>> {
    const key = `solana:token-created:${mint}`;
    const cached = await this.readCache<string>(key);
    if (cached !== null) return { value: cached, servedBy: this.deps.rpc.heliusConfigured ? 'helius' : 'solana_rpc' };
    const { signaturePageLimit, maxSignaturePages } = this.deps.config;
    let before: string | undefined;
    let servedBy: RpcCallResult<null>['servedBy'] = 'solana_rpc';
    for (let page = 0; page < maxSignaturePages; page += 1) {
      const result = await this.deps.rpc.getSignaturesForAddress(mint, signaturePageLimit, before, signal);
      servedBy = result.servedBy;
      const list = result.value;
      const oldest = list[list.length - 1];
      if (oldest === undefined) break;
      if (list.length < signaturePageLimit) {
        const iso = typeof oldest.blockTime === 'number' ? toIsoDate(oldest.blockTime * 1_000, this.deps.clock.now()) : null;
        if (iso !== null) await this.writeCache(key, iso, this.deps.config.cacheTtlSeconds.tokenAge);
        return { value: iso, servedBy };
      }
      before = oldest.signature;
    }
    return { value: null, servedBy };
  }

  /** Concentration : RPC (top 20 comptes + propriétaires), repli sur le top holders RugCheck. */
  private async holders(
    mint: string,
    parsedMint: ParsedMint | null,
    pools: ReadonlySet<string>,
    rugcheck: RugCheckDigest | null,
    tracker: SourceTracker,
    rpcFallback: DataSourceId,
    signal: AbortSignal,
  ): Promise<{ value: RiskFacts['holders']; source: DataSourceId | null }> {
    const vaults = new Set(rugcheck?.vaultTokenAccounts ?? []);
    const excludedOwners = new Set([...Object.keys(KNOWN_EXCLUDED_OWNERS), ...pools]);
    const isExcludedBase = (entry: HolderEntry) => vaults.has(entry.tokenAccount) || excludedOwners.has(entry.owner);

    if (parsedMint !== null && BigInt(parsedMint.supply) > 0n) {
      const servedBy = <T>(result: RpcCallResult<T>): DataSourceId => result.servedBy;
      const largest = await tracker.track(servedBy, rpcFallback, () => this.deps.rpc.getTokenLargestAccounts(mint, signal));
      if (largest !== null && largest.value.length > 0) {
        const tokenAccounts = largest.value.map((entry) => entry.address);
        const owners = await tracker.track(servedBy, rpcFallback, () => this.deps.rpc.getTokenAccountOwners(tokenAccounts, signal));
        const ownerList = owners?.value ?? [];
        const uniqueOwners = [...new Set(ownerList.filter((owner): owner is string => owner !== null))];
        const programs =
          uniqueOwners.length > 0
            ? await tracker.track(servedBy, rpcFallback, () => this.deps.rpc.getAccountPrograms(uniqueOwners, signal))
            : null;
        const ammOwners = new Set(
          uniqueOwners.filter((owner, index) => {
            const program = programs?.value[index];
            return program !== null && program !== undefined && program in KNOWN_AMM_PROGRAMS;
          }),
        );
        const supply = BigInt(parsedMint.supply);
        const entries: HolderEntry[] = largest.value.map((entry, index) => ({
          tokenAccount: entry.address,
          owner: ownerList[index] ?? entry.address,
          pct: shareOf(BigInt(entry.amount), supply),
        }));
        return {
          value: concentration(entries, (entry) => isExcludedBase(entry) || ammOwners.has(entry.owner)),
          source: largest.servedBy,
        };
      }
    }

    // Repli : top holders de RugCheck (rapport complet uniquement).
    if (rugcheck !== null && rugcheck.complete && rugcheck.topHolders.length > 0) {
      const entries: HolderEntry[] = rugcheck.topHolders.map((holder) => ({
        tokenAccount: holder.address,
        owner: holder.owner,
        pct: clampPct(holder.pct) ?? 0,
      }));
      return { value: concentration(entries, isExcludedBase), source: 'rugcheck' };
    }
    return { value: null, source: null };
  }

  /**
   * Devis de vente Jupiter (**aucune transaction**) d'environ `sellTestAmountUsd` vers USDC
   * (SOL pour USDC lui-même). Impact = `priceImpactPct` × 100 ; taxe implicite = écart entre le
   * montant reçu et la valeur de marché diminuée de l'impact.
   */
  private async sellSimulation(
    mint: string,
    parsedMint: ParsedMint,
    dex: readonly DexPair[] | null,
    gecko: readonly GeckoPool[] | null,
    rugcheck: RugCheckDigest | null,
    tracker: SourceTracker,
    signal: AbortSignal,
  ): Promise<{ value: RiskFacts['sellSimulation'] }> {
    const { sellTestAmountUsd } = this.deps.config;
    const price = priceUsd(mint, dex, gecko);
    const outputMint = mint === USDC_MINT ? WSOL_MINT : USDC_MINT;
    const unit = 10n ** BigInt(parsedMint.decimals);
    let amount = unit;
    if (price !== null) {
      const raw = Math.floor((sellTestAmountUsd / price) * 10 ** parsedMint.decimals);
      amount = Number.isFinite(raw) && raw >= 1 ? BigInt(raw) : 1n;
    }
    const quote = await tracker.track('jupiter', 'jupiter', () => this.deps.jupiter.getSellQuote(mint, outputMint, amount, signal));
    if (quote === null) return { value: null };
    if (!quote.routeFound) {
      // Courbe de liaison pump.fun : la revente passe par le programme pump.fun, que Jupiter ne route
      // pas toujours. Ce n'est pas un honeypot : contrôle « indisponible » plutôt que faux Danger.
      const bondingCurve = rugcheck?.pumpBondingCurve === true || (dex ?? []).some((pair) => pair.dexId === 'pumpfun');
      if (bondingCurve) return { value: null };
      return { value: { routeFound: false, priceImpactPct: null, implicitTaxPct: null, testAmountUsd: price === null ? 0 : sellTestAmountUsd } };
    }
    const impact = clampPct(quote.priceImpactPct * 100);
    const outUsd = outputMint === USDC_MINT ? Number(quote.outAmount) / 1e6 : null;
    let tax: number | null = null;
    if (price !== null && outUsd !== null && impact !== null && impact < 100) {
      tax = clampPct((1 - outUsd / (sellTestAmountUsd * (1 - impact / 100))) * 100);
    }
    const testAmountUsd = price !== null ? sellTestAmountUsd : (outUsd ?? 0);
    return { value: { routeFound: true, priceImpactPct: impact, implicitTaxPct: tax, testAmountUsd } };
  }

  /** Métadonnées modifiables : Helius DAS, sinon extension Token-2022, sinon RugCheck. */
  private metadata(
    das: DasAsset | null,
    parsedMint: ParsedMint | null,
    rugcheck: RugCheckDigest | null,
  ): { value: RiskFacts['metadata']; source: DataSourceId } {
    if (das !== null) return { value: { mutable: das.mutable }, source: 'helius' };
    const embedded = parsedMint === null ? null : token2022Metadata(parsedMint);
    if (embedded !== null) return { value: { mutable: embedded.mutable }, source: this.deps.rpc.heliusConfigured ? 'helius' : 'solana_rpc' };
    if (rugcheck !== null && rugcheck.metadata.mutable !== null) return { value: { mutable: rugcheck.metadata.mutable }, source: 'rugcheck' };
    return { value: null, source: this.deps.das.configured ? 'helius' : 'rugcheck' };
  }

  private async creator(mint: string, rugcheck: RugCheckDigest | null, nowMs: number): Promise<RiskFacts['creator']> {
    const key = `solana:creator:${mint}`;
    const cached = await this.readCache<NonNullable<RiskFacts['creator']>>(key);
    if (cached !== null) return cached;
    const { creatorDeadMarketCapUsd, creatorDeadMinAgeHours, cacheTtlSeconds } = this.deps.config;
    const facts = buildCreatorFacts(mint, rugcheck, {
      nowMs,
      deadMarketCapUsd: creatorDeadMarketCapUsd,
      deadMinAgeHours: creatorDeadMinAgeHours,
    });
    if (facts !== null) await this.writeCache(key, facts, cacheTtlSeconds.creator);
    return facts;
  }

  private tokenName(
    mint: string,
    das: DasAsset | null,
    parsedMint: ParsedMint | null,
    dex: readonly DexPair[] | null,
    rugcheck: RugCheckDigest | null,
    field: 'name' | 'symbol',
  ): string | null {
    const max = field === 'name' ? 64 : 16;
    const embedded = parsedMint === null ? null : token2022Metadata(parsedMint);
    const pair = (dex ?? []).find((entry) => entry.baseToken.address === mint);
    const candidates: unknown[] = [das?.content?.metadata?.[field], embedded?.[field], pair?.baseToken[field], rugcheck?.metadata[field]];
    for (const candidate of candidates) {
      const cleaned = cleanName(candidate, max);
      if (cleaned !== null) return cleaned;
    }
    return null;
  }

  private checkSources(
    mint: string,
    used: { rpc: DataSourceId; holders: DataSourceId; metadata: DataSourceId; lpFromRugcheck: boolean; light: boolean },
  ): Record<AnalysisCheckId, DataSourceRef[]> {
    const ref = (id: DataSourceId) => sourceRef(id, mint);
    const liquidity: DataSourceRef[] = [ref('dexscreener')];
    if (!used.light) liquidity.push(ref('geckoterminal'));
    if (used.lpFromRugcheck) liquidity.push(ref('rugcheck'));
    const map: Record<AnalysisCheckId, DataSourceRef[]> = {
      mint_authority: [ref(used.rpc)],
      freeze_authority: [ref(used.rpc)],
      liquidity,
      holder_concentration: [ref(used.holders)],
      sell_simulation: [ref('jupiter'), ref('dexscreener')],
      metadata_mutable: [ref(used.metadata)],
      token_age: [ref(used.rpc), ref('dexscreener')],
      creator_history: [ref('rugcheck')],
      rugcheck: [ref('rugcheck')],
    };
    // Ordre garanti identique à ANALYSIS_CHECK_IDS.
    return Object.fromEntries(ANALYSIS_CHECK_IDS.map((id) => [id, map[id]])) as Record<AnalysisCheckId, DataSourceRef[]>;
  }

  private async readCache<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.deps.cache.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      this.deps.logger.warn('solana_cache_read_failed', { key: key.split(':').slice(0, 2).join(':') });
      return null;
    }
  }

  private async writeCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.deps.cache.set(key, JSON.stringify(value), ttlSeconds);
    } catch {
      this.deps.logger.warn('solana_cache_write_failed', { key: key.split(':').slice(0, 2).join(':') });
    }
  }
}
