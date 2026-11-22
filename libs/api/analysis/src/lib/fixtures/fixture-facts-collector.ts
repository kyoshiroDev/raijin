import type { RiskFacts } from '@raijin/shared-contracts';
import {
  AnalysisClock,
  FactsCollector,
  UpstreamUnavailableError,
  type CollectedFacts,
  type CollectedTokenInfo,
  type SourceStatus,
} from '../ports/facts-collector';

/**
 * Doublure de test du port `FactsCollector` (tests unitaires de l'orchestration, de la page publique
 * et de l'image OG) : scénarios synthétiques, dont un nom hostile. Adresses base58 valides de
 * 32 octets, sans existence on-chain. Aucun appel réseau. (Le mode `ANALYSIS_FIXTURES=1` de l'API
 * rejoue, lui, les enregistrements réels de `@raijin/api-solana`.)
 */
export const FIXTURE_MINTS = {
  safe: '8hVdV1j7khEZ1FukoH65EvpwuMZPszv1ikjNSbEnGypt',
  warn: '8hVdV1j7khEZ1FukoH65Ey1QDa5rBDvp2GsjRs582K4u',
  danger: '8hVdV1j7khEZ1FukoH65EnemiGwJRJcsjvp243nrhRn2',
  degraded: '8hVdV1j7khEZ1FukoH65EnfGAbDnoocQF6FZ2pAgzTYX',
  /** Nom et symbole hostiles (HTML, guillemets, bidi, zéro largeur) : tests d'échappement. */
  hostile: '8hVdV1j7khEZ1FukoH65Eprx6moMyXE2jUY8yPbsQ6kU',
  /** Toutes les sources critiques en panne : 503 `UPSTREAM_UNAVAILABLE`. */
  down: '8hVdV1j7khEZ1FukoH65EngWEY4Anpk1QLqUJCLb4U7f',
  /** Adresse valide sans token : 404 `TOKEN_NOT_FOUND`. */
  notFound: '8hVdV1j7khEZ1FukoH65Et8d6LYTzjVkmfcXW8aohsTU',
  /** Adresse de paire (lien DexScreener) résolue vers `safe`. */
  pair: '8hVdV1j7khEZ1FukoH65EuC7WHoEaMFMenEemoJdxCoR',
} as const;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const HOSTILE_TOKEN_NAME = `<script>alert("x")</script>' onload="y" \u202Eevil\u200B & <b>`;

function ok(...ids: SourceStatus['source'][]): SourceStatus[] {
  return ids.map((source) => ({ source, status: 'ok', latencyMs: 12 }));
}

type MintAccountFacts = NonNullable<RiskFacts['mintAccount']>;

function mintAccount(overrides: Partial<MintAccountFacts> = {}): MintAccountFacts {
  return {
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    tokenProgram: 'spl-token',
    extensions: { transferFeeBps: null, permanentDelegate: false, transferHook: false, nonTransferable: false },
    ...overrides,
  };
}

function healthy(mint: string, now: Date): RiskFacts {
  return {
    version: 1,
    mint,
    observedAt: now.toISOString(),
    mintAccount: mintAccount(),
    metadata: { mutable: false },
    liquidity: {
      usd: 1_250_000,
      samples: [
        { source: 'dexscreener', usd: 1_240_000 },
        { source: 'geckoterminal', usd: 1_260_000 },
      ],
      lpBurnedOrLockedPct: 99.5,
      lpRemoved: false,
    },
    holders: { top10Pct: 18.4, maxSingleHolderPct: 3.1, excludedAccounts: 2 },
    sellSimulation: { routeFound: true, priceImpactPct: 0.3, implicitTaxPct: 0, testAmountUsd: 50 },
    age: {
      tokenCreatedAt: new Date(now.getTime() - 400 * DAY_MS).toISOString(),
      poolCreatedAt: new Date(now.getTime() - 390 * DAY_MS).toISOString(),
    },
    creator: { address: null, tokensLaunched: 0, tokensDeadOrRugged: 0 },
    rugcheck: { scoreNormalised: 3, rugged: false, risks: [] },
  };
}

const ALL_SOURCES = ok('helius', 'dexscreener', 'geckoterminal', 'jupiter', 'rugcheck');

function token(name: string | null, symbol: string | null): CollectedTokenInfo {
  return { name, symbol, decimals: 6, tokenProgram: 'spl-token' };
}

/** Collecteur simulé : scénarios fixes, horodatés avec l'horloge injectée. */
export class FixtureFactsCollector extends FactsCollector {
  /** Nombre de collectes réelles (tests de cache et de déduplication). */
  calls = 0;

  constructor(
    private readonly clock: AnalysisClock,
    private readonly delayMs = 0,
  ) {
    super();
  }

  async resolveMint(address: string): Promise<string | null> {
    return address === FIXTURE_MINTS.pair ? FIXTURE_MINTS.safe : null;
  }

  async collectFacts(mint: string): Promise<CollectedFacts | null> {
    this.calls += 1;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const now = this.clock.now();
    const base = healthy(mint, now);
    switch (mint) {
      case FIXTURE_MINTS.safe:
        return { facts: base, token: token('Raijin Demo', 'RJDEMO'), sources: ALL_SOURCES };
      case FIXTURE_MINTS.warn:
        return {
          facts: {
            ...base,
            metadata: { mutable: true },
            holders: { top10Pct: 48, maxSingleHolderPct: 12.5, excludedAccounts: 1 },
            age: {
              tokenCreatedAt: new Date(now.getTime() - 20 * HOUR_MS).toISOString(),
              poolCreatedAt: new Date(now.getTime() - 18 * HOUR_MS).toISOString(),
            },
          },
          token: token('Prudence Demo', 'PRUD'),
          sources: ALL_SOURCES,
        };
      case FIXTURE_MINTS.danger:
        return {
          facts: {
            ...base,
            mintAccount: mintAccount({ mintAuthorityActive: true, freezeAuthorityActive: true }),
            sellSimulation: { routeFound: false, priceImpactPct: null, implicitTaxPct: null, testAmountUsd: 50 },
          },
          token: token('Danger Demo', 'RUG'),
          sources: ALL_SOURCES,
        };
      case FIXTURE_MINTS.degraded:
        return {
          facts: { ...base, creator: null, rugcheck: null, sellSimulation: null },
          token: token('Partiel Demo', 'PART'),
          sources: [
            ...ok('helius', 'dexscreener', 'geckoterminal'),
            { source: 'jupiter', status: 'error', latencyMs: 4000 },
            { source: 'rugcheck', status: 'error', latencyMs: 3000 },
          ],
        };
      case FIXTURE_MINTS.hostile:
        return { facts: base, token: token(HOSTILE_TOKEN_NAME, `"><img src=x>`), sources: ALL_SOURCES };
      case FIXTURE_MINTS.down:
        throw new UpstreamUnavailableError();
      default:
        return null;
    }
  }
}
