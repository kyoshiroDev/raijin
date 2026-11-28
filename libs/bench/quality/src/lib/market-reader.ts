import { DexPairSchema, SOURCE_HOSTS, bestPairPerToken, getJson, parseEach, type DexPair } from '@raijin/bench-engine';
import type { SolanaDataService } from '@raijin/api-solana';
import { UNKNOWN_MARKET, type MarketReading } from './verdict-model';

const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/tokens/v1/solana/';
/** Mints par appel `/tokens/v1` (limite DexScreener : 30). */
const DEX_BATCH = 30;

/** Sources de la relève : marché (DexScreener, sans crédit Helius) et offre brute (`getMultipleAccounts`, voie `watch`). */
export abstract class MarketReader {
  abstract markets(mints: readonly string[]): Promise<Map<string, MarketReading>>;
  abstract supplies(mints: readonly string[]): Promise<Map<string, string>>;
}

/** Lecture d'une paire DexScreener → mesures de la relève (`null` = valeur absente, jamais 0 par défaut). */
export function readingFromPair(pair: DexPair | undefined, answered: boolean): MarketReading {
  if (!answered) return UNKNOWN_MARKET;
  if (!pair) return { poolFound: false, priceUsd: null, liquidityUsd: null, volume24hUsd: null };
  const price = typeof pair.priceUsd === 'number' ? pair.priceUsd : Number(pair.priceUsd);
  return {
    poolFound: true,
    priceUsd: Number.isFinite(price) && price >= 0 ? price : null,
    liquidityUsd: typeof pair.liquidity?.usd === 'number' ? pair.liquidity.usd : null,
    volume24hUsd: typeof pair.volume?.h24 === 'number' ? pair.volume.h24 : null,
  };
}

/**
 * Lecteur du banc : DexScreener par le client d'origine du scan (`getJson`, hôtes en liste blanche, `fetch` enveloppé
 * par le recul sur 429 de `@raijin/bench-solana`), offre brute par `api-solana` (`collectAuthoritiesBatch`).
 */
export class BenchMarketReader extends MarketReader {
  constructor(
    private readonly service: Pick<SolanaDataService, 'collectAuthoritiesBatch'>,
    private readonly fetchJson: (url: string) => Promise<unknown | null> = (url) => getJson(url, { hosts: SOURCE_HOSTS, log: () => undefined }),
  ) {
    super();
  }

  async markets(mints: readonly string[]): Promise<Map<string, MarketReading>> {
    const out = new Map<string, MarketReading>();
    for (let i = 0; i < mints.length; i += DEX_BATCH) {
      const chunk = mints.slice(i, i + DEX_BATCH);
      const payload = await this.fetchJson(`${DEXSCREENER_TOKENS}${chunk.join(',')}`);
      const answered = payload !== null;
      const best = new Map(bestPairPerToken(parseEach(DexPairSchema, payload ?? [])).map((p) => [p.baseToken.address, p]));
      for (const mint of chunk) out.set(mint, readingFromPair(best.get(mint), answered));
    }
    return out;
  }

  async supplies(mints: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (mints.length === 0) return out;
    try {
      for (const entry of await this.service.collectAuthoritiesBatch(mints)) if (entry.status === 'ok') out.set(entry.mint, entry.supply);
    } catch {
      // Source indisponible : offre inconnue (aucun MINT_USED ne peut être conclu).
    }
    return out;
  }
}
