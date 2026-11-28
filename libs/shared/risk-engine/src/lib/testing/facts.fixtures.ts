import type { RiskFacts } from '@raijin/shared-contracts';

/**
 * Faits de référence du moteur (scénarios de docs/SCORING.md). Valeurs inspirées des
 * enregistrements réels de `libs/api/solana/src/fixtures` (22/11/2026), arrondies.
 */
export const OBSERVED_AT = '2026-11-22T04:00:00.000Z';

const HEALTHY_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/** Token établi, autorités révoquées, liquidité profonde et verrouillée. */
export function healthyFacts(overrides: Partial<RiskFacts> = {}): RiskFacts {
  return {
    version: 1,
    mint: HEALTHY_MINT,
    observedAt: OBSERVED_AT,
    mintAccount: {
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      tokenProgram: 'spl-token',
      extensions: { transferFeeBps: null, permanentDelegate: false, transferHook: false, nonTransferable: false },
    },
    metadata: { mutable: false },
    liquidity: {
      usd: 1_137_040,
      samples: [
        { source: 'dexscreener', usd: 1_100_000 },
        { source: 'geckoterminal', usd: 1_174_080 },
      ],
      lpBurnedOrLockedPct: 100,
      lpRemoved: false,
    },
    holders: { top10Pct: 22.4, maxSingleHolderPct: 6.1, excludedAccounts: 3 },
    sellSimulation: { routeFound: true, priceImpactPct: 0.18, implicitTaxPct: 0.4, testAmountUsd: 100 },
    age: { tokenCreatedAt: '2022-12-25T00:00:00.000Z', poolCreatedAt: '2023-01-02T00:00:00.000Z' },
    creator: { address: '9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw', tokensLaunched: 0, tokensDeadOrRugged: 0 },
    rugcheck: { scoreNormalised: 1, rugged: false, risks: [] },
    ...overrides,
  };
}

/** USDC : mint et freeze actifs, émetteur régulé connu. */
export function usdcFacts(): RiskFacts {
  const base = healthyFacts();
  return {
    ...base,
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    mintAccount: {
      mintAuthorityActive: true,
      freezeAuthorityActive: true,
      tokenProgram: 'spl-token',
      extensions: { transferFeeBps: null, permanentDelegate: false, transferHook: false, nonTransferable: false },
    },
    metadata: { mutable: true },
  };
}

/** Token pump.fun de quelques minutes, créateur lanceur en série (enregistrement réel, anonymisé). */
export function freshPumpFacts(): RiskFacts {
  const base = healthyFacts();
  return {
    ...base,
    mint: '9rA3rJrcFJeQwWaLaHgJLi4LaF6wvRoae9ybwcYApump',
    metadata: { mutable: false },
    liquidity: { usd: 1_684, samples: [{ source: 'geckoterminal', usd: 1_684 }], lpBurnedOrLockedPct: 100, lpRemoved: false },
    holders: { top10Pct: 41.3, maxSingleHolderPct: 18.2, excludedAccounts: 1 },
    sellSimulation: { routeFound: true, priceImpactPct: 6.9, implicitTaxPct: 1.2, testAmountUsd: 100 },
    age: { tokenCreatedAt: '2026-11-22T03:08:24.000Z', poolCreatedAt: '2026-11-22T03:08:25.000Z' },
    creator: { address: 'EhWKytfVrJPGUYkbtnt6kJRR2RvvN5Ht4B1jB7YjxASA', tokensLaunched: 14, tokensDeadOrRugged: 9 },
    rugcheck: {
      scoreNormalised: 38,
      rugged: false,
      risks: [{ name: 'Creator history of rugged tokens', level: 'danger' }],
    },
  };
}

/** Toutes les sources en panne sauf aucune : seul le mint et l'horodatage sont connus. */
export function emptyFacts(): RiskFacts {
  return {
    version: 1,
    mint: HEALTHY_MINT,
    observedAt: OBSERVED_AT,
    mintAccount: null,
    metadata: null,
    liquidity: null,
    holders: null,
    sellSimulation: null,
    age: null,
    creator: null,
    rugcheck: null,
  };
}
