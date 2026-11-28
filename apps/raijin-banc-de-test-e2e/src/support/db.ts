import { Client } from 'pg';
import {
  BENCH_E2E_DATABASE_URL,
  FIXTURE_SCAN_MARKER,
  FIXTURE_SHADOW_ID_MIN,
  FIXTURE_TOKENS,
  OWNER_EMAIL,
} from './bench';

/** Garde-fou : uniquement une base de test du banc (`raijin_bench_dev`, `raijin_bench_e2e`), jamais la production. */
export function assertTestDatabase(url = BENCH_E2E_DATABASE_URL): void {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/^raijin_bench_(dev|e2e)$/.test(name)) throw new Error(`e2e du banc refusé : base « ${name} » (attendu raijin_bench_dev ou raijin_bench_e2e)`);
}

export async function withDb<T>(run: (db: Client) => Promise<T>): Promise<T> {
  assertTestDatabase();
  const db = new Client({ connectionString: BENCH_E2E_DATABASE_URL });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}

/** Refuse de toucher un propriétaire qui n'est pas celui de l'e2e ; supprime un reste d'un passage interrompu. */
export async function ensureNoForeignOwner(db: Client): Promise<void> {
  const owners = await db.query<{ email: string }>('select email from public.bench_owner');
  const foreign = owners.rows.filter((row) => row.email !== OWNER_EMAIL);
  if (foreign.length > 0)
    throw new Error('e2e du banc refusé : la base contient déjà un propriétaire qui n’est pas celui de l’e2e (rien n’a été modifié).');
  await deleteOwner(db);
}

/** Supprime le propriétaire de test (TOTP, codes de secours et sessions suivent par ON DELETE CASCADE). */
export async function deleteOwner(db: Client): Promise<number> {
  const result = await db.query('delete from public.bench_owner where email = $1', [OWNER_EMAIL]);
  return result.rowCount ?? 0;
}

const DAY_MS = 86_400_000;
/** Jours UTC complets de l'instantané de fixture (≥ SHADOW_ACCEPTANCE.minFullDays = 3). */
export const FIXTURE_SNAPSHOT_DAYS = 4;
/** Lignes par jour : 40 dans la référence Supabase, 30 sur le VPS → écart de 25 % (tolérance scan_runs : 2 %). */
export const FIXTURE_REF_PER_DAY = 40;
export const FIXTURE_VPS_PER_DAY = 30;

export async function insertFixtures(db: Client): Promise<void> {
  await deleteFixtures(db);
  const now = Date.now();
  for (const [index, token] of FIXTURE_TOKENS.entries()) {
    const ageMs = (index + 1) * 2 * 3_600_000;
    await db.query(
      `insert into public.tokens (mint, symbol, name, pair_address, dex_id, price_usd, market_cap, liquidity_usd, volume_24h,
         change_5m, change_1h, change_24h, buys_1h, sells_1h, buys_24h, sells_24h, pair_created_at, first_seen_at, updated_at,
         mint_authority_disabled, freeze_authority_disabled, top10_pct, holder_count, sources, spark_6h)
       values ($1, $2, $3, $4, 'raydium', 0.00042, 420000, 85000, 150000, 1.5, 4.2, 12.5, 120, 80, 900, 700,
         $5, $5, now(), true, true, 18.5, 1200, array['dex_profiles'], array[1,1.1,1.05,1.2]::real[])`,
      [token.mint, token.symbol, token.name, token.pair, new Date(now - ageMs)],
    );
  }
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const from = new Date(today - FIXTURE_SNAPSHOT_DAYS * DAY_MS);
  const to = new Date(today);
  await db.query(
    `insert into shadow_ref.snapshot_meta (taken_at, window_from, window_to, row_counts) values (now(), $1, $2, $3)`,
    [from, to, JSON.stringify({ e2e: 'banc', scan_runs: FIXTURE_REF_PER_DAY * FIXTURE_SNAPSHOT_DAYS })],
  );
  for (let day = 0; day < FIXTURE_SNAPSHOT_DAYS; day += 1) {
    for (let n = 0; n < FIXTURE_REF_PER_DAY; n += 1) {
      const startedAt = new Date(from.getTime() + day * DAY_MS + (n + 1) * 30 * 60_000 * 0.7);
      await db.query(
        `insert into shadow_ref.scan_runs (id, started_at, finished_at, tokens_seen, tokens_kept) values ($1, $2, $2, 10, 3)`,
        [FIXTURE_SHADOW_ID_MIN + day * 1000 + n, startedAt],
      );
      if (n < FIXTURE_VPS_PER_DAY)
        await db.query(`insert into public.scan_runs (started_at, finished_at, tokens_seen, tokens_kept) values ($1, $1, $2, 3)`, [
          startedAt,
          FIXTURE_SCAN_MARKER,
        ]);
    }
  }
}

export async function deleteFixtures(db: Client): Promise<void> {
  await db.query('delete from public.tokens where mint = any($1)', [FIXTURE_TOKENS.map((token) => token.mint)]);
  await db.query('delete from public.scan_runs where tokens_seen = $1', [FIXTURE_SCAN_MARKER]);
  await db.query('delete from shadow_ref.scan_runs where id >= $1 and id < $2', [FIXTURE_SHADOW_ID_MIN, FIXTURE_SHADOW_ID_MIN + 1_000_000]);
  await db.query(`delete from shadow_ref.snapshot_meta where row_counts->>'e2e' = 'banc'`);
}
