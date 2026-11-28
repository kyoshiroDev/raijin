import type { RiskFacts } from '@raijin/shared-contracts';

/**
 * Analyse de démonstration (docs/ARCHITECTURE.md §15.4) : token **fictif**, nommé « Exemple ». Aucune adresse réelle,
 * aucune marque : le champ `mint` est un libellé interne jamais affiché ni interrogé. Les faits sont choisis pour
 * montrer les trois statuts de contrôle (OK, Attention, Indisponible) et un verdict Prudence ; ce verdict est calculé
 * au build par `@raijin/shared-risk-engine`, comme pour une vraie analyse.
 */
export const DEMO_TOKEN = {
  name: 'Exemple',
  symbol: 'EXEMPLE',
} as const;

const OBSERVED_AT = '2026-01-15T12:00:00.000Z';

export const DEMO_FACTS: RiskFacts = {
  version: 1,
  mint: 'ExempleFictifNonInterroge',
  observedAt: OBSERVED_AT,
  mintAccount: {
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    tokenProgram: 'spl-token',
    extensions: { transferFeeBps: null, permanentDelegate: false, transferHook: false, nonTransferable: false },
  },
  metadata: { mutable: true },
  liquidity: {
    usd: 84_000,
    samples: [
      { source: 'dexscreener', usd: 83_000 },
      { source: 'geckoterminal', usd: 85_000 },
    ],
    lpBurnedOrLockedPct: 98,
    lpRemoved: false,
  },
  holders: { top10Pct: 41, maxSingleHolderPct: 7, excludedAccounts: 2 },
  sellSimulation: { routeFound: true, priceImpactPct: 1.2, implicitTaxPct: 0.4, testAmountUsd: 50 },
  age: { tokenCreatedAt: '2026-01-06T09:00:00.000Z', poolCreatedAt: '2026-01-06T10:00:00.000Z' },
  creator: null,
  rugcheck: { scoreNormalised: 22, rugged: false, risks: [] },
};
