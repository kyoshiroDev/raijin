import type { RiskFacts } from '@raijin/shared-contracts';
import { isSolanaAddress } from '@raijin/shared-util';
import type { DexPair } from '../clients/dexscreener';
import type { GeckoPool } from '../clients/geckoterminal';
import type { ParsedMint } from '../clients/solana-rpc';
import type { RugCheckDigest } from './rugcheck-digest';
import { clampPct } from './rugcheck-digest';

type MintAccountFacts = NonNullable<RiskFacts['mintAccount']>;
type LiquidityFacts = NonNullable<RiskFacts['liquidity']>;
type HolderFacts = NonNullable<RiskFacts['holders']>;
type CreatorFacts = NonNullable<RiskFacts['creator']>;

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** Dates plausibles (Solana mainnet : 2020) : toute autre valeur externe est ignorée. */
const MIN_DATE_MS = Date.UTC(2020, 0, 1);

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function toIsoDate(ms: number | null | undefined, nowMs: number): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < MIN_DATE_MS || ms > nowMs + 86_400_000) return null;
  return new Date(ms).toISOString();
}

function stateOf(mint: ParsedMint, name: string): Record<string, unknown> | null {
  const extension = mint.extensions?.find((entry) => entry.extension === name);
  return extension === undefined ? null : (extension.state ?? {});
}

function readBps(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const bps = (value as { transferFeeBasisPoints?: unknown }).transferFeeBasisPoints;
  return typeof bps === 'number' && Number.isInteger(bps) && bps >= 0 && bps <= 10_000 ? bps : 0;
}

function activeAddress(value: unknown): boolean {
  return typeof value === 'string' && isSolanaAddress(value) && value !== SYSTEM_PROGRAM;
}

/** Autorités et extensions Token-2022 à risque (frais : le plus élevé des deux barèmes, prudent). */
export function buildMintAccountFacts(mint: ParsedMint): MintAccountFacts {
  const fee = stateOf(mint, 'transferFeeConfig');
  const delegate = stateOf(mint, 'permanentDelegate');
  const hook = stateOf(mint, 'transferHook');
  return {
    mintAuthorityActive: activeAddress(mint.mintAuthority),
    freezeAuthorityActive: activeAddress(mint.freezeAuthority),
    tokenProgram: mint.program,
    extensions: {
      transferFeeBps: fee === null ? null : Math.max(readBps(fee['newerTransferFee']), readBps(fee['olderTransferFee'])),
      permanentDelegate: delegate !== null && activeAddress(delegate['delegate']),
      transferHook: hook !== null && activeAddress(hook['programId']),
      nonTransferable: stateOf(mint, 'nonTransferable') !== null,
    },
  };
}

/** Métadonnées Token-2022 embarquées (extension `tokenMetadata`), lisibles sans DAS. */
export function token2022Metadata(mint: ParsedMint): { mutable: boolean; name: unknown; symbol: unknown } | null {
  const state = stateOf(mint, 'tokenMetadata');
  if (state === null) return null;
  return { mutable: activeAddress(state['updateAuthority']), name: state['name'], symbol: state['symbol'] };
}

function involves(pair: DexPair, mint: string): boolean {
  return pair.baseToken.address === mint || pair.quoteToken.address === mint;
}

function geckoBaseIsMint(pool: GeckoPool, mint: string): boolean {
  return pool.relationships?.base_token?.data?.id === `solana_${mint}`;
}

/** Médiane des liquidités totales DexScreener / GeckoTerminal, LP et retrait (ARCHITECTURE.md §9). */
export function buildLiquidityFacts(
  mint: string,
  dex: readonly DexPair[] | null,
  gecko: readonly GeckoPool[] | null,
  rugcheck: RugCheckDigest | null,
  lpRemovedMaxUsd: number,
): LiquidityFacts | null {
  if (dex === null && gecko === null && rugcheck === null) return null;
  const samples: LiquidityFacts['samples'] = [];
  if (dex !== null) {
    const pairs = dex.filter((pair) => involves(pair, mint));
    const priced = pairs.filter((pair) => typeof pair.liquidity?.usd === 'number' && Number.isFinite(pair.liquidity.usd) && pair.liquidity.usd >= 0);
    if (pairs.length === 0 || priced.length > 0) {
      samples.push({ source: 'dexscreener', usd: priced.reduce((sum, pair) => sum + (pair.liquidity?.usd ?? 0), 0) });
    }
  }
  if (gecko !== null) {
    const priced = gecko.filter((pool) => pool.attributes.reserve_in_usd !== null && pool.attributes.reserve_in_usd >= 0);
    if (gecko.length === 0 || priced.length > 0) {
      samples.push({ source: 'geckoterminal', usd: priced.reduce((sum, pool) => sum + (pool.attributes.reserve_in_usd ?? 0), 0) });
    }
  }
  const usd = median(samples.map((sample) => sample.usd));
  const poolsExist = (dex?.length ?? 0) > 0 || (gecko?.length ?? 0) > 0 || (rugcheck?.marketCount ?? 0) > 0;
  let lpRemoved: boolean | null = null;
  if (rugcheck?.rugged === true) lpRemoved = true;
  else if (usd !== null && poolsExist) lpRemoved = usd < lpRemovedMaxUsd;
  return { usd, samples, lpBurnedOrLockedPct: rugcheck?.lpBurnedOrLockedPct ?? null, lpRemoved };
}

/** Prix USD médian du token (paires où il est le token de base). */
export function priceUsd(mint: string, dex: readonly DexPair[] | null, gecko: readonly GeckoPool[] | null): number | null {
  const prices: number[] = [];
  for (const pair of dex ?? []) {
    if (pair.baseToken.address === mint && typeof pair.priceUsd === 'number' && Number.isFinite(pair.priceUsd) && pair.priceUsd > 0) {
      prices.push(pair.priceUsd);
    }
  }
  for (const pool of gecko ?? []) {
    const price = pool.attributes.base_token_price_usd;
    if (geckoBaseIsMint(pool, mint) && price !== null && price > 0) prices.push(price);
  }
  return median(prices);
}

/** Création du pool principal (plus grosse liquidité), DexScreener puis GeckoTerminal. */
export function mainPoolCreatedAt(
  mint: string,
  dex: readonly DexPair[] | null,
  gecko: readonly GeckoPool[] | null,
  nowMs: number,
): string | null {
  const pairs = (dex ?? []).filter((pair) => involves(pair, mint));
  const mainPair = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const fromDex = toIsoDate(mainPair?.pairCreatedAt, nowMs);
  if (fromDex !== null) return fromDex;
  const mainPool = [...(gecko ?? [])].sort((a, b) => (b.attributes.reserve_in_usd ?? 0) - (a.attributes.reserve_in_usd ?? 0))[0];
  const created = mainPool?.attributes.pool_created_at;
  return created ? toIsoDate(Date.parse(created), nowMs) : null;
}

/** Adresses de pools connues (exclues de la concentration). */
export function poolAddresses(dex: readonly DexPair[] | null, gecko: readonly GeckoPool[] | null, rugcheck: RugCheckDigest | null): Set<string> {
  return new Set([
    ...(dex ?? []).map((pair) => pair.pairAddress),
    ...(gecko ?? []).map((pool) => pool.attributes.address),
    ...(rugcheck?.poolAccounts ?? []),
  ]);
}

export interface HolderEntry {
  /** Clé d'agrégation : propriétaire si connu, sinon le compte de token. */
  readonly owner: string;
  readonly tokenAccount: string;
  /** Part du supply (%). */
  readonly pct: number;
}

/** Top 10 et plus gros wallet, comptes exclus retirés, parts agrégées par propriétaire. */
export function concentration(entries: readonly HolderEntry[], isExcluded: (entry: HolderEntry) => boolean): HolderFacts {
  const byOwner = new Map<string, number>();
  let excluded = 0;
  for (const entry of entries) {
    if (isExcluded(entry)) {
      excluded += 1;
      continue;
    }
    byOwner.set(entry.owner, (byOwner.get(entry.owner) ?? 0) + entry.pct);
  }
  const sorted = [...byOwner.values()].sort((a, b) => b - a);
  const top10 = sorted.slice(0, 10).reduce((sum, pct) => sum + pct, 0);
  return {
    top10Pct: clampPct(top10) ?? 0,
    maxSingleHolderPct: clampPct(sorted[0] ?? 0) ?? 0,
    excludedAccounts: excluded,
  };
}

/** Part en % d'un montant brut (BigInt, sans perte sur les supplies de 18+ chiffres). */
export function shareOf(amount: bigint, supply: bigint): number {
  if (supply <= 0n) return 0;
  return Number((amount * 1_000_000n) / supply) / 10_000;
}

/** Historique du créateur d'après RugCheck (tokens lancés hors token analysé, morts = petite capi + ancien). */
export function buildCreatorFacts(
  mint: string,
  digest: RugCheckDigest | null,
  options: { nowMs: number; deadMarketCapUsd: number; deadMinAgeHours: number },
): CreatorFacts | null {
  if (digest === null || !digest.complete || digest.creator === null) return null;
  const others = digest.creatorTokens.filter((token) => token.mint !== mint);
  const dead = others.filter((token) => {
    const created = token.createdAt === null ? Number.NaN : Date.parse(token.createdAt);
    const oldEnough = Number.isFinite(created) && options.nowMs - created >= options.deadMinAgeHours * 3_600_000;
    return oldEnough && (token.marketCap ?? 0) < options.deadMarketCapUsd;
  }).length;
  return { address: digest.creator, tokensLaunched: others.length, tokensDeadOrRugged: dead };
}

/** Faits RugCheck (source complémentaire, libellés déjà nettoyés). */
export function buildRugcheckFacts(digest: RugCheckDigest | null): RiskFacts['rugcheck'] {
  if (digest === null) return null;
  return { scoreNormalised: digest.scoreNormalised, rugged: digest.rugged, risks: [...digest.risks] };
}
