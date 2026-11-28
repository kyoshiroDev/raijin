import {
  WALLET_SCAN_MAX_DELEGATIONS,
  WALLET_SCAN_MAX_ITEMS,
  walletScanResultSchema,
  type DataSourceId,
  type WalletDelegation,
  type WalletScanResult,
  type WalletToken,
  type WalletTokenAssessment,
} from '@raijin/shared-contracts';
import type { WalletHoldings, WalletHoldingToken } from '../ports/wallet-data-source';
import { rawGte, tokenAmount } from './wallet-utils';

/** Tri : valeur connue décroissante, puis valeur inconnue (ordre stable par mint). */
export function sortHoldings(tokens: readonly WalletHoldingToken[]): WalletHoldingToken[] {
  return [...tokens].sort((a, b) => {
    if (a.valueUsd !== null && b.valueUsd !== null && a.valueUsd !== b.valueUsd) return b.valueUsd - a.valueUsd;
    if (a.valueUsd === null && b.valueUsd !== null) return 1;
    if (a.valueUsd !== null && b.valueUsd === null) return -1;
    return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
  });
}

/** Mints à analyser et statut des autres (poussière, au-delà du plafond). */
export interface HoldingsPlan {
  readonly sorted: readonly WalletHoldingToken[];
  readonly toAnalyze: readonly string[];
  readonly notAnalyzed: ReadonlyMap<string, WalletTokenAssessment>;
}

/**
 * Prix connu et valeur < `dustUsd` → poussière ; **prix inconnu ≠ poussière** (les airdrops
 * d'arnaque n'ont souvent pas de prix). Les `maxTokens` premiers non-poussière sont analysés.
 */
export function planHoldings(tokens: readonly WalletHoldingToken[], maxTokens: number, dustUsd: number): HoldingsPlan {
  const sorted = sortHoldings(tokens);
  const toAnalyze: string[] = [];
  const notAnalyzed = new Map<string, WalletTokenAssessment>();
  for (const token of sorted) {
    if (token.valueUsd !== null && token.valueUsd < dustUsd) notAnalyzed.set(token.mint, { status: 'not_analyzed', reason: 'dust' });
    else if (toAnalyze.length < maxTokens) toAnalyze.push(token.mint);
    else notAnalyzed.set(token.mint, { status: 'not_analyzed', reason: 'over_limit' });
  }
  return { sorted, toAnalyze, notAnalyzed };
}

function metadata(token: { mint: string; name: string | null; symbol: string | null; decimals: number; tokenProgram: WalletToken['tokenProgram'] }) {
  return { mint: token.mint, name: token.name, symbol: token.symbol, decimals: token.decimals, tokenProgram: token.tokenProgram, untrusted: true as const };
}

/**
 * Tokens affichés (au plus `WALLET_SCAN_MAX_ITEMS`), dans l'ordre du tri : tous les tokens analysés
 * (même à prix inconnu, classés après la poussière), puis les autres tant qu'il reste de la place.
 */
function listed(tokens: readonly WalletToken[], analyzed: ReadonlySet<string>): WalletToken[] {
  let room = Math.max(0, WALLET_SCAN_MAX_ITEMS - tokens.filter((token) => analyzed.has(token.mint)).length);
  return tokens.filter((token) => {
    if (analyzed.has(token.mint)) return true;
    if (room === 0) return false;
    room -= 1;
    return true;
  });
}

export interface BuildScanInput {
  readonly address: string;
  readonly holdings: WalletHoldings;
  readonly plan: HoldingsPlan;
  readonly assessments: ReadonlyMap<string, WalletTokenAssessment>;
  readonly engineVersion: string;
  readonly scannedAt: Date;
  readonly partial: boolean;
}

/**
 * Résultat contractuel du scan, validé par `walletScanResultSchema.parse` (garde de sortie : nom et
 * symbole non fiables nettoyés et bornés, montants et adresses revalidés). Le résumé compte **tout**
 * le wallet ; les listes sont bornées par le contrat.
 */
export function buildScanResult(input: BuildScanInput): WalletScanResult {
  const { holdings, plan } = input;
  const byMint = new Map(holdings.tokens.map((token) => [token.mint, token]));
  const tokens = plan.sorted.map((token): WalletToken => {
    const assessment = input.assessments.get(token.mint) ?? plan.notAnalyzed.get(token.mint) ?? { status: 'unavailable', reason: 'timeout' };
    return {
      mint: token.mint,
      tokenProgram: token.tokenProgram,
      token: metadata(token),
      balance: tokenAmount(token.amountRaw, token.decimals),
      valueUsd: token.valueUsd,
      accountCount: Math.min(1000, Math.max(1, token.accountCount)),
      frozen: token.frozen,
      delegated: token.delegated,
      assessment,
    };
  });
  const delegations = holdings.delegations.map((delegation): WalletDelegation => {
    const known = byMint.get(delegation.mint);
    return {
      tokenAccount: delegation.tokenAccount,
      mint: delegation.mint,
      tokenProgram: delegation.tokenProgram,
      token: known
        ? metadata(known)
        : delegation.name || delegation.symbol
          ? metadata({ mint: delegation.mint, name: delegation.name ?? null, symbol: delegation.symbol ?? null, decimals: delegation.decimals, tokenProgram: delegation.tokenProgram })
          : null,
      delegate: delegation.delegate,
      delegatedAmount: tokenAmount(delegation.delegatedAmountRaw, delegation.decimals),
      balance: tokenAmount(delegation.balanceRaw, delegation.decimals),
      coversFullBalance: rawGte(delegation.delegatedAmountRaw, delegation.balanceRaw),
    };
  });
  // Délégations couvrant tout le solde d'abord (les plus urgentes à vérifier).
  delegations.sort((a, b) => Number(b.coversFullBalance) - Number(a.coversFullBalance));

  const analyzed = tokens.filter((token) => token.assessment.status === 'analyzed');
  const verdicts = { safe: 0, warn: 0, danger: 0 };
  for (const token of analyzed) if (token.assessment.status === 'analyzed') verdicts[token.assessment.verdict] += 1;
  const known = tokens.filter((token) => token.valueUsd !== null);
  const count = (predicate: (token: WalletToken) => boolean) => tokens.filter(predicate).length;
  const sources = [...new Set<DataSourceId>(holdings.sources)].slice(0, 6);

  return walletScanResultSchema.parse({
    address: input.address,
    summary: {
      tokenCount: tokens.length,
      analyzedCount: analyzed.length,
      verdicts,
      unavailableCount: count((token) => token.assessment.status === 'unavailable'),
      overLimitCount: count((token) => token.assessment.status === 'not_analyzed' && token.assessment.reason === 'over_limit'),
      dustCount: count((token) => token.assessment.status === 'not_analyzed' && token.assessment.reason === 'dust'),
      nftCount: holdings.nftCount,
      emptyAccountCount: holdings.emptyAccountCount,
      delegationCount: delegations.length,
      totalValueUsd: known.length > 0 ? known.reduce((sum, token) => sum + (token.valueUsd ?? 0), 0) : null,
    },
    tokens: listed(tokens, new Set(plan.toAnalyze)),
    delegations: delegations.slice(0, WALLET_SCAN_MAX_DELEGATIONS),
    sources,
    engineVersion: input.engineVersion,
    scannedAt: input.scannedAt.toISOString(),
    cached: false,
    partial: input.partial,
  });
}
