import { Client } from 'pg';

/**
 * Déclencheurs et fonctions SQL des migrations, sur une vraie base Postgres déjà migrée
 * (`BENCH_TEST_DATABASE_URL`, cible `bench-prisma:test-db`). Valeurs attendues = comportement des
 * fonctions d'origine de Supabase (corps identiques, vérifiés par migrations.spec.ts). Chaque test
 * tourne dans une transaction annulée : la base reste vide.
 */

const url = process.env['BENCH_TEST_DATABASE_URL'];
if (!url)
  throw new Error(
    'BENCH_TEST_DATABASE_URL manquant (base de test jetable, déjà migrée).',
  );

const MINT = 'So11111111111111111111111111111111111111112';
const PAIR = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const OWNER = '0193a6f0-0000-7000-8000-000000000001';
const HOUR = 3_600_000;

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: url });
  await db.connect();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query('BEGIN');
});
afterEach(async () => {
  await db.query('ROLLBACK');
});

async function insertOwner(): Promise<void> {
  await db.query(
    `INSERT INTO public.bench_owner (id, email) VALUES ($1, 'owner@example.com')`,
    [OWNER],
  );
}

async function insertToken(pairCreatedAt: Date | null): Promise<void> {
  await db.query(
    `INSERT INTO public.tokens (mint, symbol, pair_address, price_usd, market_cap, liquidity_usd, volume_24h, pair_created_at)
     VALUES ($1, 'WSOL', $2, 1, 1000, 1000, 100, $3)`,
    [MINT, PAIR, pairCreatedAt],
  );
}

async function errorOf(
  run: () => Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  await db.query('SAVEPOINT attempt');
  try {
    await run();
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT attempt');
    return error as { code?: string; message: string };
  }
  throw new Error('une erreur était attendue');
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

describe('compte unique (bench_owner, P2)', () => {
  it('bench_owner_id() vaut null sans compte, puis l’id du propriétaire', async () => {
    expect(
      (await db.query('SELECT public.bench_owner_id() AS id')).rows[0].id,
    ).toBeNull();
    await insertOwner();
    expect(
      (await db.query('SELECT public.bench_owner_id() AS id')).rows[0].id,
    ).toBe(OWNER);
  });

  it('un seul compte (singleton), e-mail en minuscules', async () => {
    await insertOwner();
    const second = await errorOf(() =>
      db.query(
        `INSERT INTO public.bench_owner (email) VALUES ('autre@example.com')`,
      ),
    );
    expect(second.code).toBe('23505');
    const upper = await errorOf(() =>
      db.query(`UPDATE public.bench_owner SET email = 'Owner@Example.com'`),
    );
    expect(upper.code).toBe('23514');
  });

  it('user_id par défaut = propriétaire (ex-auth.uid())', async () => {
    await insertOwner();
    const row = await db.query(
      `INSERT INTO public.alert_settings DEFAULT VALUES RETURNING user_id`,
    );
    expect(row.rows[0].user_id).toBe(OWNER);
  });

  it('RPC d’origine : « not authenticated » (42501) sans compte, ouverture paper avec compte', async () => {
    await insertToken(new Date(Date.now() - 2 * HOUR));
    const refused = await errorOf(() =>
      db.query(
        `SELECT * FROM public.paper_open_position($1, 'all_x2', 0.1, 0.5)`,
        [MINT],
      ),
    );
    expect(refused.code).toBe('42501');
    expect(refused.message).toBe('not authenticated');

    await insertOwner();
    const opened = await db.query(
      `SELECT * FROM public.paper_open_position($1, 'all_x2', 0.1, 0.5)`,
      [MINT],
    );
    expect(opened.rows[0]).toMatchObject({
      user_id: OWNER,
      book: 'main',
      mint: MINT,
      symbol: 'WSOL',
      status: 'pending',
    });
    const wallet = await db.query(
      `SELECT book FROM public.paper_wallets WHERE user_id = $1`,
      [OWNER],
    );
    expect(wallet.rows.map((r) => r.book)).toEqual(['main']);
  });

  it('supprimer le compte efface ses données (ON DELETE CASCADE, comme auth.users)', async () => {
    await insertOwner();
    await db.query(`INSERT INTO public.alert_settings DEFAULT VALUES`);
    await db.query(`DELETE FROM public.bench_owner`);
    expect(
      (await db.query(`SELECT count(*)::int AS n FROM public.alert_settings`))
        .rows[0].n,
    ).toBe(0);
  });
});

describe('déclencheurs de points de contrôle (P5)', () => {
  it('signal_outcomes : étiquette à +12 h, bougies 1 min à +6 h (paire < 48 h), 5 min à +72 h', async () => {
    const detected = new Date(Date.now() - HOUR);
    await insertToken(new Date(detected.getTime() - 10 * HOUR));
    const row = await db.query(
      `INSERT INTO public.signal_outcomes (mint, pair_address, detected_at, entry_price, features)
       VALUES ($1, $2, $3, 0.5, '{}') RETURNING next_label_at, candles_1m_at, candles_5m_at`,
      [MINT, PAIR, detected],
    );
    expect(iso(row.rows[0].next_label_at)).toBe(
      new Date(detected.getTime() + 12 * HOUR).toISOString(),
    );
    expect(iso(row.rows[0].candles_1m_at)).toBe(
      new Date(detected.getTime() + 6 * HOUR).toISOString(),
    );
    expect(iso(row.rows[0].candles_5m_at)).toBe(
      new Date(detected.getTime() + 72 * HOUR).toISOString(),
    );
  });

  it('signal_outcomes : paire de plus de 48 h → pas de bougies 1 min ; valeurs fournies conservées', async () => {
    const detected = new Date(Date.now() - HOUR);
    const label = new Date(detected.getTime() + 3 * HOUR);
    await insertToken(new Date(detected.getTime() - 72 * HOUR));
    const row = await db.query(
      `INSERT INTO public.signal_outcomes (mint, pair_address, detected_at, entry_price, features, next_label_at, candles_1m_at)
       VALUES ($1, $2, $3, 0.5, '{}', $4, $4) RETURNING next_label_at, candles_1m_at, candles_5m_at`,
      [MINT, PAIR, detected, label],
    );
    expect(iso(row.rows[0].next_label_at)).toBe(label.toISOString());
    expect(row.rows[0].candles_1m_at).toBeNull();
    expect(iso(row.rows[0].candles_5m_at)).toBe(
      new Date(detected.getTime() + 72 * HOUR).toISOString(),
    );
  });

  it('preset_signals : détection de plus de 30 j → étiquette seule, aucune bougie', async () => {
    const detected = new Date(Date.now() - 31 * 24 * HOUR);
    const row = await db.query(
      `INSERT INTO public.preset_signals (preset, mint, pair_address, detected_at, entry_price)
       VALUES ('young_calm', $1, $2, $3, 0.5) RETURNING next_label_at, candles_1m_at, candles_5m_at`,
      [MINT, PAIR, detected],
    );
    expect(iso(row.rows[0].next_label_at)).toBe(
      new Date(detected.getTime() + 12 * HOUR).toISOString(),
    );
    expect(row.rows[0].candles_1m_at).toBeNull();
    expect(row.rows[0].candles_5m_at).toBeNull();
  });

  it('preset_signals : token inconnu (pas de pair_created_at) → bougies 1 min programmées', async () => {
    const detected = new Date(Date.now() - HOUR);
    const row = await db.query(
      `INSERT INTO public.preset_signals (preset, mint, pair_address, detected_at, entry_price)
       VALUES ('young_frenzy', $1, $2, $3, 0.5) RETURNING candles_1m_at`,
      [MINT, PAIR, detected],
    );
    expect(iso(row.rows[0].candles_1m_at)).toBe(
      new Date(detected.getTime() + 6 * HOUR).toISOString(),
    );
  });

  it('backtest_events : bougies 1 min à +6 h et 5 min à +72 h', async () => {
    const at = new Date(Date.now() - HOUR);
    const row = await db.query(
      `INSERT INTO public.backtest_events (preset, mint, pool, event_at, entry_snapshot_id, price_at_event, roundtrip_known, conditions)
       VALUES ('young_calm_ev', $1, $2, $3, 1, 0.5, false, '{}') RETURNING candles_1m_at, candles_5m_at`,
      [MINT, PAIR, at],
    );
    expect(iso(row.rows[0].candles_1m_at)).toBe(
      new Date(at.getTime() + 6 * HOUR).toISOString(),
    );
    expect(iso(row.rows[0].candles_5m_at)).toBe(
      new Date(at.getTime() + 72 * HOUR).toISOString(),
    );
  });
});

describe('autres déclencheurs', () => {
  it('paper_positions : symbole recopié depuis tokens, token inconnu refusé (23503)', async () => {
    await insertOwner();
    const unknown = await errorOf(() =>
      db.query(
        `INSERT INTO public.paper_positions (user_id, mint, symbol, strategy, stake_sol, entry_target_price, sl_price, expires_at)
         VALUES ($1, $2, 'X', 'all_x2', 0.1, 0.5, 0.35, now() + interval '1 day')`,
        [OWNER, MINT],
      ),
    );
    expect(unknown.code).toBe('23503');
    expect(unknown.message).toBe('paper position: unknown token');

    await insertToken(null);
    await db.query(
      `INSERT INTO public.paper_wallets (user_id, book) VALUES ($1, 'main')`,
      [OWNER],
    );
    const row = await db.query(
      `INSERT INTO public.paper_positions (user_id, mint, symbol, strategy, stake_sol, entry_target_price, sl_price, expires_at)
       VALUES ($1, $2, 'FAUX', 'all_x2', 0.1, 0.5, 0.35, now() + interval '1 day') RETURNING symbol`,
      [OWNER, MINT],
    );
    expect(row.rows[0].symbol).toBe('WSOL');
  });

  it('push_subscriptions : 10 abonnements au plus par compte', async () => {
    await insertOwner();
    const insert = (i: number) =>
      db.query(
        `INSERT INTO public.push_subscriptions (endpoint, p256dh, auth) VALUES ($1, $2, $3)`,
        [
          `https://fcm.googleapis.com/fcm/send/abonnement-${i}`,
          'B'.repeat(87),
          'a'.repeat(22),
        ],
      );
    for (let i = 0; i < 10; i += 1) await insert(i);
    const eleventh = await errorOf(() => insert(10));
    expect(eleventh.code).toBe('23514');
    expect(eleventh.message).toBe('too many push subscriptions');
  });

  it('alert_settings : updated_at remis à now() à chaque mise à jour', async () => {
    await insertOwner();
    await db.query(
      `INSERT INTO public.alert_settings (updated_at) VALUES ('2026-01-01T00:00:00Z')`,
    );
    const row = await db.query(
      `UPDATE public.alert_settings SET enabled = true RETURNING updated_at, now() AS now`,
    );
    expect(iso(row.rows[0].updated_at)).toBe(iso(row.rows[0].now));
  });
});

describe('tables du VPS', () => {
  it('job_runs : statut skipped (début = fin), running sans fin, erreur ≤ 500 caractères', async () => {
    await db.query(
      `INSERT INTO public.job_runs (job, status, finished_at, duration_ms) VALUES ('scan-tokens', 'skipped', now(), 0)`,
    );
    await db.query(`INSERT INTO public.job_runs (job) VALUES ('scan-tokens')`);
    const runningWithEnd = await errorOf(() =>
      db.query(
        `INSERT INTO public.job_runs (job, status, finished_at) VALUES ('scan-tokens', 'running', now())`,
      ),
    );
    expect(runningWithEnd.code).toBe('23514');
    const longError = await errorOf(() =>
      db.query(
        `INSERT INTO public.job_runs (job, status, finished_at, error) VALUES ('scan-tokens', 'failed', now(), $1)`,
        ['x'.repeat(501)],
      ),
    );
    expect(longError.code).toBe('23514');
    const unknownStatus = await errorOf(() =>
      db.query(
        `INSERT INTO public.job_runs (job, status) VALUES ('scan-tokens', 'paused')`,
      ),
    );
    expect(unknownStatus.code).toBe('22P02');
  });

  it('bench_sessions : 12 h au plus, motif de révocation obligatoire', async () => {
    await insertOwner();
    const tooLong = await errorOf(() =>
      db.query(
        `INSERT INTO public.bench_sessions (owner_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '13 hours')`,
        [OWNER, 'h'.repeat(64)],
      ),
    );
    expect(tooLong.code).toBe('23514');
    await db.query(
      `INSERT INTO public.bench_sessions (owner_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '12 hours')`,
      [OWNER, 'h'.repeat(64)],
    );
    const noReason = await errorOf(() =>
      db.query(`UPDATE public.bench_sessions SET revoked_at = now()`),
    );
    expect(noReason.code).toBe('23514');
  });

  it('verdict_records : un verdict par (mint, version), suivi unique par horizon, supply u64', async () => {
    const insert = (version: string) =>
      db.query(
        `INSERT INTO public.verdict_records (mint, verdict_at, engine_version, verdict, facts, facts_version, baseline_supply_raw)
         VALUES ($1, now(), $2, 'danger', '{"version":"1"}', '1', 18446744073709551615) RETURNING id`,
        [MINT, version],
      );
    const { rows } = await insert('1.0.0');
    await insert('1.0.0-variante.top10-40');
    expect((await errorOf(() => insert('1.0.0'))).code).toBe('23505');
    const observe = () =>
      db.query(
        `INSERT INTO public.follow_up_observations (record_id, horizon, observed_at, status, events) VALUES ($1, '24h', now(), 'rug', '{LP_REMOVED}')`,
        [rows[0].id],
      );
    await observe();
    expect((await errorOf(() => observe())).code).toBe('23505');
    const badEvent = await errorOf(() =>
      db.query(
        `INSERT INTO public.follow_up_observations (record_id, horizon, observed_at, events) VALUES ($1, '72h', now(), '{GAIN}')`,
        [rows[0].id],
      ),
    );
    expect(badEvent.code).toBe('23514');
  });

  it('engine_variants : identifiant `reference` réservé', async () => {
    const reserved = await errorOf(() =>
      db.query(
        `INSERT INTO public.engine_variants (id, label, fingerprint) VALUES ('reference', 'Réf', '0a1b2c3d')`,
      ),
    );
    expect(reserved.code).toBe('23514');
    const row = await db.query(
      `INSERT INTO public.engine_variants (id, label, fingerprint) VALUES ('top10-40', 'Top 10 à 40 %', '0a1b2c3d') RETURNING enabled`,
    );
    expect(row.rows[0].enabled).toBe(false);
  });

  it('shadow_ref : mêmes colonnes que public, correspondance des colonnes de date', async () => {
    const cols = async (schema: string) =>
      (
        await db.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tokens' ORDER BY ordinal_position`,
          [schema],
        )
      ).rows.map((r) => r.column_name);
    expect(await cols('shadow_ref')).toEqual(await cols('public'));
    expect(
      (await db.query(`SELECT shadow_ref.day_column('alert_log') AS c`)).rows[0]
        .c,
    ).toBe('sent_at');
  });
});
