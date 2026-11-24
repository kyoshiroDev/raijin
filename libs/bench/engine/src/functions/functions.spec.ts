import { BenchDb } from '../db/bench-db';
import { MemoryDbExecutor } from '../db/memory-executor';
import { setRuntimeFetch } from '../ported/runtime-fetch';
import { GECKO_MULTI, JUP_BUY, JUP_SELL, RUG_DANGER, RUG_REPORT_CLEAN } from '../ported/test-support/enrich-fixtures';
import { GECKO_OHLCV_15M } from '../ported/test-support/x3-fixtures';
import { runBacktestRun } from './backtest-run';
import { runEnrichTokens } from './enrich-tokens';
import { runLabelOutcomes } from './label-outcomes';
import { runPaperEngine } from './paper-engine';
import { runScanTokens } from './scan-tokens';
import { historySourceFromPort, runWalletStudyCollect, type WalletHistoryPort } from './wallet-study-collect';

/**
 * Tests des 7 fonctions portées (un par job) : base en mémoire (`MemoryDbExecutor`, mêmes requêtes que PostgREST),
 * réponses d'API **enregistrées** (`ported/test-support`, données publiques du 16/11/2026), aucun appel réseau :
 * le `fetch` du processus est remplacé par un routeur de fixtures, et toute URL inconnue échoue le test.
 */
const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const OWNER = '6f1c2a5e-8d3b-4f7a-9c1e-2b4d6f8a0c11';

type Route = [RegExp, unknown | ((url: string) => unknown)];
const calls: string[] = [];

function routeFetch(routes: Route[]) {
  calls.length = 0;
  setRuntimeFetch(async (input) => {
    calls.push(input);
    for (const [pattern, body] of routes) {
      if (pattern.test(input)) {
        const payload = typeof body === 'function' ? (body as (u: string) => unknown)(input) : body;
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('{}', { status: 404 });
  });
}

const noNetwork = () => routeFetch([]);
const env = (values: Record<string, string> = {}) => (name: string) => values[name];
const quiet = () => {
  for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(console, level).mockImplementation(() => undefined);
};

beforeEach(() => {
  quiet();
  noNetwork();
  // Garde-fou : le `fetch` global n'est jamais appelé (toute sortie passe par le routeur de fixtures).
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    throw new Error(`réseau interdit dans les tests : ${String(input).slice(0, 60)}`);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  // Jamais de retour au `fetch` global : un traitement encore en cours après le test ne peut pas sortir sur le réseau.
  setRuntimeFetch(async () => {
    throw new Error('réseau interdit après le test');
  });
});

function tokenRow(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    mint: MINT,
    symbol: 'BAWSAQ',
    name: 'Bawsaq',
    pair_address: PAIR,
    dex_id: 'pumpswap',
    price_usd: 0.00165,
    market_cap: 1_650_000,
    liquidity_usd: 95_000,
    volume_24h: 400_000,
    volume_1h: 40_000,
    change_5m: 1,
    change_1h: 5,
    change_6h: 10,
    change_24h: 20,
    buys_1h: 300,
    sells_1h: 200,
    buys_24h: 3000,
    sells_24h: 2000,
    pair_created_at: new Date(now - 5 * 3_600_000).toISOString(),
    updated_at: new Date(now - 60_000).toISOString(),
    rugcheck_at: null,
    ...over,
  };
}

describe('enrich-tokens (port Node)', () => {
  it('GeckoTerminal + RugCheck + aller-retour Jupiter enregistrés → UPDATE des seules colonnes d’enrichissement', async () => {
    routeFetch([
      [/api\.geckoterminal\.com/, GECKO_MULTI],
      [/rugcheck\.xyz\/.*\/summary$/, RUG_DANGER],
      [/rugcheck\.xyz\/.*\/report$/, RUG_REPORT_CLEAN],
      [/jup\.ag\/.*inputMint=So111/, JUP_BUY],
      [/jup\.ag\//, JUP_SELL],
    ]);
    const exec = new MemoryDbExecutor({ tables: { tokens: [tokenRow()] } });
    const stats = await runEnrichTokens({ db: new BenchDb(exec), env: env() });
    expect(stats).toMatchObject({ tokens: 1, gecko: 1, rugcheck: 1, quotes: 1 });
    const row = exec.table('tokens')[0]!;
    expect(row['liquidity_gecko_usd']).toBeCloseTo(95_340.44, 1);
    expect(row['lp_locked_pct']).not.toBeNull();
    expect(Array.isArray(row['rugcheck_dangers'])).toBe(true);
    expect(typeof row['roundtrip_cost_pct']).toBe('number');
    expect(typeof row['enriched_at']).toBe('string');
    // Écriture conditionnelle (concurrence optimiste) : un seul UPDATE filtré sur updated_at lu.
    const update = exec.queries.find((q) => q.action === 'update');
    expect(update?.filters.map((f) => (f.kind === 'cmp' ? f.column : f.kind))).toEqual(['mint', 'updated_at']);
    expect(calls.every((u) => /^https:\/\/(api\.geckoterminal\.com|api\.rugcheck\.xyz|(lite-)?api\.jup\.ag)\//.test(u))).toBe(true);
  });

  it('aucun token frais : aucun appel externe', async () => {
    const exec = new MemoryDbExecutor({ tables: { tokens: [tokenRow({ updated_at: '2026-01-01T00:00:00Z' })] } });
    expect(await runEnrichTokens({ db: new BenchDb(exec), env: env() })).toMatchObject({ tokens: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('label-outcomes (port Node)', () => {
  it('rattrapage, étiquetage et journal label_runs sur bougies GeckoTerminal enregistrées', async () => {
    routeFetch([[/api\.geckoterminal\.com\/.*ohlcv/, GECKO_OHLCV_15M]]);
    const detectedAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const exec = new MemoryDbExecutor({
      tables: {
        signal_outcomes: [
          { mint: MINT, pair_address: PAIR, detected_at: detectedAt, entry_price: 0.0011, status: 'pending', label_attempts: 0, labelled_at: null, next_label_at: null, candles_1m_at: null, candles_5m_at: null, candles_attempts: 0, pair_age_h: 2 },
        ],
      },
      rpc: { x3_backfill_candidates: () => [] },
    });
    const stats = await runLabelOutcomes({ db: new BenchDb(exec) });
    expect(stats.calls).toBeGreaterThanOrEqual(1);
    expect(exec.table('label_runs')).toHaveLength(1);
    const outcome = exec.table('signal_outcomes')[0]!;
    expect(outcome['label_attempts']).toBeGreaterThanOrEqual(1);
    expect(calls.every((u) => u.startsWith('https://api.geckoterminal.com/'))).toBe(true);
  });
});

describe('paper-engine (port Node, SIMULATION)', () => {
  it('position ouverte, prix ×2 au dernier snapshot → un pas paper_apply_v2 (atomique, garde optimiste)', async () => {
    // Horloge accélérée : les devis Jupiter ne partent qu'à t = 10 s (budget d'origine conservé).
    jest.useFakeTimers({ advanceTimers: 1000 });
    routeFetch([[/jup\.ag\/swap\/v1\/quote\?inputMint=So111/, JUP_BUY], [/jup\.ag\/swap\/v1\/quote/, JUP_SELL]]);
    const created = new Date(Date.now() - 3_600_000).toISOString();
    const exec = new MemoryDbExecutor({
      tables: {
        paper_positions: [
          { id: '00000000-0000-4000-8000-000000000001', user_id: OWNER, book: 'main', mint: MINT, strategy: 'all_x2', status: 'open', stake_sol: 0.5, entry_target_price: 1, fill_price: 1, sl_price: 0.7, created_at: created, filled_at: created, expires_at: new Date(Date.now() + 86_400_000).toISOString(), entry_mode: 'limit' },
        ],
        paper_legs: [
          { id: '00000000-0000-4000-8000-0000000000a1', position_id: '00000000-0000-4000-8000-000000000001', size_pct: 100, tp_price: 2, status: 'open', stop_price: 0.7, exit_price: null, closed_at: null },
        ],
        token_snapshots: [{ mint: MINT, price_usd: 2.2, captured_at: new Date(Date.now() - 30_000).toISOString() }],
      },
      rpc: { paper_apply_v2: () => 1.4 },
    });
    const stats = await runPaperEngine({ db: new BenchDb(exec), env: env() });
    expect(stats).toMatchObject({ loaded: 1, open: 1, failed: 0 });
    expect(exec.rpcCalls.map((c) => c.name)).toEqual(['paper_apply_v2']);
    expect(exec.rpcCalls[0]!.args['p_position']).toBe('00000000-0000-4000-8000-000000000001');
    expect(exec.rpcCalls[0]!.args['p_expected']).toBe('open');
    jest.useRealTimers();
  }, 20_000);

  it('aucune position : rien n’est lu ni demandé', async () => {
    const exec = new MemoryDbExecutor();
    expect(await runPaperEngine({ db: new BenchDb(exec), env: env() })).toMatchObject({ loaded: 0 });
    expect(exec.rpcCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe('backtest-run (port Node, SIMULATION)', () => {
  it('aucun run actif : avance l’analyseur d’événements (curseur créé sous bail), sans erreur', async () => {
    const exec = new MemoryDbExecutor();
    const out = await runBacktestRun({ db: new BenchDb(exec) });
    expect(out['idle']).toBe(true);
    expect(exec.table('backtest_event_state').map((r) => r['key'])).toContain('cursor');
  });

  it('run déjà sous bail d’un autre appel : rien n’est touché', async () => {
    const exec = new MemoryDbExecutor({
      tables: {
        backtest_runs: [{ id: 7, status: 'running', cursor: null, started_at: new Date().toISOString(), created_at: new Date().toISOString(), locked_until: new Date(Date.now() + 60_000).toISOString() }],
      },
    });
    expect(await runBacktestRun({ db: new BenchDb(exec) })).toMatchObject({ skipped: 'locked' });
  });
});

describe('wallet-study-collect (port Node, ÉTUDE HORS LIGNE)', () => {
  const unavailable = (state: string): WalletHistoryPort => ({ state: async () => state, page: async () => ({ status: 'unavailable', reason: state }) });

  it.each(['not_configured', 'method_unavailable', 'budget_exhausted'])('source %s : rien n’est réservé ni demandé', async (state) => {
    const exec = new MemoryDbExecutor({ rpc: {} });
    expect(await runWalletStudyCollect({ db: new BenchDb(exec), history: unavailable(state) })).toEqual({ skipped: state });
    expect(exec.rpcCalls).toHaveLength(0);
  });

  it('source active : bail SQL, file, réservation des crédits, page analysée par le parseur d’origine', async () => {
    const pages: string[] = [];
    const history: WalletHistoryPort = {
      state: async () => 'active',
      page: async (address) => {
        pages.push(address);
        return { status: 'ok', page: { entries: [], next: null } };
      },
    };
    const exec = new MemoryDbExecutor({
      tables: { wallet_study_budget: [{ id: 1, credits_used: 0, hard_cap: 600_000 }] },
      // Valeurs par défaut des colonnes (migration) à l'insertion de l'état.
      defaults: { wallet_study_state: (row) => ({ status: 'pending', cursor: null, pages: 0, buyers: 0, creator: null, creator_checked: false, pool_creator: null, attempts: 0, dropped_txs: 0, ...row }) },
      rpc: {
        wallet_study_claim: () => '11111111-1111-4111-8111-111111111111',
        wallet_study_release: () => null,
        wallet_study_queue: () => [{ mint: MINT, pair_address: PAIR, pair_created_at: new Date(Date.now() - 86_400_000).toISOString(), detected_at: new Date(Date.now() - 86_400_000).toISOString(), is_new: true }],
        wallet_study_reserve: () => true,
        wallet_study_refund: () => null,
      },
    });
    const stats = await runWalletStudyCollect({ db: new BenchDb(exec), history });
    expect(stats).toMatchObject({ mints: 1 });
    expect(pages.length).toBeGreaterThanOrEqual(1);
    const names = exec.rpcCalls.map((c) => c.name);
    expect(names[0]).toBe('wallet_study_claim');
    expect(names).toContain('wallet_study_reserve');
    expect(names[names.length - 1]).toBe('wallet_study_release');
  });

  it('indisponibilité en cours d’appel → HistoryError « outage » (arrêt, remboursement)', async () => {
    const source = historySourceFromPort(unavailable('budget_exhausted'));
    await expect(source.page(MINT, null, 100)).rejects.toMatchObject({ name: 'HistoryError', kind: 'outage' });
  });
});

describe('scan-tokens (port Node)', () => {
  const pair = {
    chainId: 'solana',
    dexId: 'pumpswap',
    pairAddress: PAIR,
    baseToken: { address: MINT, name: 'Bawsaq', symbol: 'BAWSAQ' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
    priceUsd: '0.00165',
    txns: { m5: { buys: 30, sells: 20 }, h1: { buys: 300, sells: 200 }, h6: { buys: 900, sells: 600 }, h24: { buys: 3000, sells: 2000 } },
    volume: { m5: 4000, h1: 40000, h6: 120000, h24: 400000 },
    priceChange: { m5: 1, h1: 5, h6: 10, h24: 20 },
    liquidity: { usd: 95000 },
    fdv: 1650000,
    marketCap: 1650000,
    pairCreatedAt: Date.now() - 5 * 3_600_000,
  };

  function scanDb(): MemoryDbExecutor {
    return new MemoryDbExecutor({
      defaults: { scan_runs: (row, seq) => ({ id: seq, started_at: new Date().toISOString(), finished_at: null, ...row }) },
      rpc: { x3_snapshot_history: () => [], apply_alert_tracking: () => 0, paper_open_position_as: () => ({ id: 'x' }) },
    });
  }

  it('candidat DexScreener (réponse enregistrée) → upsert tokens + snapshot + scan_runs terminé ; mode ombre : ni push ni auto-paper', async () => {
    routeFetch([
      [/api\.dexscreener\.com\/token-profiles|token-boosts|community-takeovers/, [{ chainId: 'solana', tokenAddress: MINT }]],
      [/api\.dexscreener\.com\/(tokens\/v1|latest\/dex\/search)/, (url: string) => (url.includes('/search') ? { pairs: [pair] } : [pair])],
    ]);
    const exec = scanDb();
    const out = await runScanTokens({ db: new BenchDb(exec), env: env({ MIN_MARKET_CAP: '50000', MIN_LIQUIDITY: '10000' }), push: null, autoPaperAllowed: () => false });
    expect(out['skipped']).toBeUndefined();
    const run = exec.table('scan_runs')[0]!;
    expect(run['finished_at']).not.toBeNull();
    expect(run['error'] ?? null).toBeNull();
    expect(exec.table('tokens').map((t) => t['mint'])).toContain(MINT);
    expect(exec.table('token_snapshots').some((s) => s['mint'] === MINT)).toBe(true);
    expect(exec.rpcCalls.map((c) => c.name)).not.toContain('paper_open_position_as');
    expect(exec.table('alert_log')).toHaveLength(0);
    expect(calls.every((u) => /^https:\/\/(api\.dexscreener\.com|api\.geckoterminal\.com|(lite-)?api\.jup\.ag|api\.rugcheck\.xyz)\//.test(u))).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 30_000);

  it('garde de chevauchement conservée : un scan plus ancien non terminé < 90 s → saut journalisé', async () => {
    const exec = scanDb();
    exec.table('scan_runs').push({ id: 0, started_at: new Date(Date.now() - 20_000).toISOString(), finished_at: null });
    const out = await runScanTokens({ db: new BenchDb(exec), env: env(), push: null, autoPaperAllowed: () => false });
    expect(out).toEqual({ skipped: 'overlap' });
    expect(exec.table('scan_runs')[1]!['error']).toBe('skipped: overlap');
    expect(calls).toHaveLength(0);
  });
});
