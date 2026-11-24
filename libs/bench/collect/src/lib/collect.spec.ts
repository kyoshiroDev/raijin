import type { BenchConfig, BenchEventBus, BenchJobHandler, BenchJobRegistry, BenchModeService, BenchNotifier, BenchRedis } from '@raijin/bench-core';
import { BenchDb, MemoryDbExecutor } from '@raijin/bench-engine';
import type { BenchSqlService } from '@raijin/bench-prisma';
import type { BenchSolana } from '@raijin/bench-solana';
import { BenchCollectJobs, scanPushPort } from './collect-jobs';
import { BenchAlertsController, BenchPushController, BenchTokensController } from './collect.controllers';

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';

function sqlOver(exec: MemoryDbExecutor, owner: string | null = '6f1c2a5e-8d3b-4f7a-9c1e-2b4d6f8a0c11'): BenchSqlService {
  return { db: new BenchDb(exec), query: async () => ({ rows: [{ id: owner }] }) } as unknown as BenchSqlService;
}

function mode(shadow: boolean): BenchModeService {
  return { isShadow: shadow, notificationsAllowed: () => !shadow, autoPaperAllowed: () => !shadow } as unknown as BenchModeService;
}

function notifier(configured = true) {
  const sendBenchPush = jest.fn(async () => ({ status: 'sent' as const }));
  return { pushConfigured: configured, pushPublicKey: configured ? 'BPUB' : null, sendBenchPush } as unknown as BenchNotifier & { sendBenchPush: jest.Mock };
}

function token(over: Record<string, unknown> = {}) {
  return {
    mint: MINT, symbol: 'BAWSAQ', name: 'Bawsaq', pair_address: 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv', dex_id: 'pumpswap',
    image_url: null, website_url: null, x_url: null, telegram_url: null, price_usd: 0.0016, market_cap: 1_600_000, liquidity_usd: 95_000,
    liquidity_jup_usd: null, volume_24h: 400_000, change_1h: 5, change_24h: 20, buys_1h: 300, sells_1h: 200,
    pair_created_at: '2026-11-24T08:00:00.123456+00:00', flags: [], mint_authority_disabled: true, freeze_authority_disabled: true,
    top10_pct: 20, holder_count: 900, organic_score: 50, first_seen_at: '2026-11-24T08:05:00+00:00', updated_at: '2026-11-24T10:00:00.5+00:00',
    liquidity_dex_usd: 95_000, liquidity_gecko_usd: 95_340, liquidity_effective_usd: 95_000, liquidity_divergence: 0.01, roundtrip_cost_pct: 2.1,
    roundtrip_fee_pct: 0.5, buy_impact_pct: 0.8, lp_locked_pct: 100, rugcheck_score: 1, rugcheck_dangers: [], price_jup_usd: null, price_gecko_usd: 0.00165,
    data_confidence: 'high', quote_at: null, rugcheck_at: null, enriched_at: null, narrative: null, narrative_rank: null, insiders_detected: false,
    creator_rug_history: false, spark_6h: [0.001, 0.0016],
    ...over,
  };
}

describe('jobs de collecte', () => {
  it('enregistre les 4 jobs portés et diffuse les tokens écrits (SSE, lignes hors contrat écartées)', async () => {
    const handlers = new Map<string, BenchJobHandler>();
    const registry = { register: (n: string, h: BenchJobHandler) => handlers.set(n, h) } as unknown as BenchJobRegistry;
    const published: unknown[] = [];
    const events = { publish: (e: unknown) => published.push(e) } as unknown as BenchEventBus;
    const solana = { service: { config: { publicRpcUrl: 'https://api.mainnet-beta.solana.com', dexscreenerBaseUrl: 'https://api.dexscreener.com', geckoterminalBaseUrl: 'https://api.geckoterminal.com/api/v2', jupiterBaseUrl: 'https://lite-api.jup.ag', rugcheckBaseUrl: 'https://api.rugcheck.xyz' } }, backoff: {}, walletStudy: {} } as unknown as BenchSolana;
    const exec = new MemoryDbExecutor({ tables: { tokens: [token(), token({ mint: 'pas-un-mint' })] } });
    const jobs = new BenchCollectJobs({ solanaEnv: {} } as unknown as BenchConfig, solana, registry, sqlOver(exec), events, mode(true), notifier());
    jobs.onModuleInit();
    expect([...handlers.keys()]).toEqual(['scan-tokens', 'enrich-tokens', 'label-outcomes', 'wallet-study-collect']);
    expect(await jobs.publishTokens(new BenchDb(exec), new Date('2026-11-24T09:00:00Z'))).toBe(1);
    expect(published).toEqual([expect.objectContaining({ type: 'token.upsert', token: expect.objectContaining({ mint: MINT }) })]);
  });

  it('push du scan : coupé en mode ombre ou sans VAPID ; sinon BenchNotifier (TTL 1 h)', async () => {
    expect(scanPushPort(notifier(), mode(true))).toBeNull();
    expect(scanPushPort(notifier(false), mode(false))).toBeNull();
    const n = notifier();
    const port = scanPushPort(n, mode(false))!;
    const res = await port.send({ endpoint: ENDPOINT, p256dh: 'k', auth: 'a' }, JSON.stringify({ notification: { title: 't' } }), { timeoutMs: 1000 });
    expect(res).toEqual({ ok: true, gone: false });
    expect(n.sendBenchPush).toHaveBeenCalledWith({ endpoint: ENDPOINT, p256dh: 'k', auth: 'a' }, { notification: { title: 't' } }, { ttlSeconds: 3600, urgency: 'normal' });
  });
});

describe('lectures du front', () => {
  it('GET /api/tokens : depuis, paires les plus jeunes d’abord, troncature signalée', async () => {
    const exec = new MemoryDbExecutor({ tables: { tokens: [token(), token({ mint: 'So11111111111111111111111111111111111111112', pair_created_at: '2026-11-24T09:00:00Z' })] } });
    const ctrl = new BenchTokensController(sqlOver(exec));
    const res = await ctrl.list({ since: '2026-11-24T00:00:00Z', limit: 1 });
    expect(res.truncated).toBe(true);
    expect(res.items[0]!.mint).toBe('So11111111111111111111111111111111111111112');
    await expect(ctrl.one({ mint: 'So11111111111111111111111111111111111111113' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('réglages : valeurs par défaut sans ligne, upsert sur le compte propriétaire', async () => {
    // Valeurs par défaut des colonnes (migration 20261124000000) à l'insertion de la ligne unique.
    const exec = new MemoryDbExecutor({
      defaults: { alert_settings: (row) => ({ enabled: false, hide_bonding_curve: true, quiet_start: 23, quiet_end: 7, max_per_hour: 4, max_per_day: 30, stake_sol: 0.05, auto_paper: false, paper_sl_pct: 30, ...row }) },
    });
    const ctrl = new BenchAlertsController(sqlOver(exec));
    expect(await ctrl.get()).toMatchObject({ enabled: false, quiet_start: 23, max_per_day: 30 });
    const saved = await ctrl.enabled({ enabled: true });
    expect(saved.enabled).toBe(true);
    expect(exec.table('alert_settings')[0]!['user_id']).toBe('6f1c2a5e-8d3b-4f7a-9c1e-2b4d6f8a0c11');
  });
});

describe('POST /api/push/test (ex-send-test-push)', () => {
  const redis = { prefixed: null } as unknown as BenchRedis;
  const subs = () => new MemoryDbExecutor({ tables: { push_subscriptions: [{ id: 1, endpoint: ENDPOINT, p256dh: 'k', auth: 'a', created_at: '2026-11-24T00:00:00Z' }] } });

  it('mode ombre : 409 BENCH_SHADOW_MODE, aucun envoi', async () => {
    const n = notifier();
    await expect(new BenchPushController(sqlOver(subs()), n, mode(true), redis).test()).rejects.toMatchObject({ code: 'BENCH_SHADOW_MODE' });
    expect(n.sendBenchPush).not.toHaveBeenCalled();
  });

  it('mode principal : envoi puis 1 test par minute', async () => {
    const n = notifier();
    const ctrl = new BenchPushController(sqlOver(subs()), n, mode(false), redis);
    expect(await ctrl.test()).toEqual({ sent: 1, failed: 0 });
    await expect(ctrl.test()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
