// Pure part of scripts/wallet-study.ts (feat/wallet-study): read-only SQL and CLI rows → WalletStudyInput.
// No I/O. Tests: scripts/wallet-study-lib_test.ts (node --experimental-strip-types --test, and deno test).
import { isSolanaAddress } from '../supabase/functions/_shared/solana.ts';
import {
  candlePeakMs,
  type EarlyBuy,
  parseBuyerRow,
  parseOutcomeRow,
  parseYoungCalmRow,
  type StudyToken,
  type WalletStudyInput,
} from '../supabase/functions/_shared/wallet-study.ts';

/**
 * Labelled detections: ×3 and ×2/stop order known, final (7 days) OR observed ≥ 12 h (first label checkpoint).
 * Decided BEFORE any early_buyers data was collected (2026-11-21): only 121 rows were final, too few for the protocol.
 * A 12 h label can only under-count ×3 (it may still happen later): conservative for the smart-wallet selection.
 * Only log_age_h is pulled out of the features.
 */
export const OUTCOMES_SQL = `
select mint, detected_at, hit_x3, x2_before_sl30, sl30_before_x2,
       max_multiple_7d::float8 as max_multiple_7d, hours_to_x2::float8 as hours_to_x2, hours_to_x3::float8 as hours_to_x3,
       jsonb_build_object('log_age_h', features -> 'log_age_h') as features
  from public.signal_outcomes
 where (status = 'final' or observed_hours >= 12)
   and hit_x3 is not null and x2_before_sl30 is not null and sl30_before_x2 is not null
 order by detected_at, mint`;

/** Early buyers (rank 1–50) filled by the Helius collector. */
export const BUYERS_SQL = `
select mint, wallet, ts, sol_amount::float8 as sol_amount, rank
  from public.early_buyers
 where rank between 1 and 50`;

/** First « Jeune calme » signal per mint. */
export const YOUNG_CALM_SQL = `
select mint, min(detected_at) as detected_at
  from public.preset_signals
 where preset = 'young_calm'
 group by mint`;

const q = (m: string): string => `'${m.replace(/'/g, "''")}'`;

/** Stored candles (1 m / 5 m) of a batch of mints, with every column decodeOhlcvRow needs; '' when no valid mint. */
export function candlesSql(mints: readonly string[]): string {
  const valid = mints.filter((m) => isSolanaAddress(m));
  if (valid.length === 0) return '';
  return `select mint, tf, ts_start, step_s, ts, o, h, l, c, v from public.ohlcv_candles
 where tf in ('1m', '5m') and mint in (${valid.map(q).join(', ')})`;
}

export interface ParsedRows<T> {
  rows: T[];
  invalid: number;
}

function parseAll<T>(rows: readonly unknown[], parse: (r: unknown) => T | null): ParsedRows<T> {
  const out: T[] = [];
  let invalid = 0;
  for (const r of rows) {
    const p = parse(r);
    if (p) out.push(p);
    else invalid++;
  }
  return { rows: out, invalid };
}

export const parseOutcomes = (rows: readonly unknown[]): ParsedRows<StudyToken> => parseAll(rows, parseOutcomeRow);
export const parseBuyers = (rows: readonly unknown[]): ParsedRows<EarlyBuy> => parseAll(rows, parseBuyerRow);

/** mint → first « Jeune calme » detection (ms); invalid rows dropped. */
export function youngCalmMap(rows: readonly unknown[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const p = parseYoungCalmRow(r);
    if (!p) continue;
    const cur = out.get(p.mint);
    if (cur === undefined || p.detectedMs < cur) out.set(p.mint, p.detectedMs);
  }
  return out;
}

/** ohlcv_candles rows (any mints) → mint → time of the highest high (ms). */
export function peakMap(rows: readonly unknown[]): Map<string, number> {
  const byMint = new Map<string, unknown[]>();
  for (const r of rows) {
    if (typeof r !== 'object' || r === null) continue;
    const m = (r as Record<string, unknown>).mint;
    if (typeof m !== 'string' || !isSolanaAddress(m)) continue;
    const list = byMint.get(m) ?? [];
    list.push(r);
    byMint.set(m, list);
  }
  const out = new Map<string, number>();
  for (const [m, list] of byMint) {
    const p = candlePeakMs(list);
    if (p !== null) out.set(m, p);
  }
  return out;
}

/** Mints of the tokens that have at least one early buyer (the only ones whose candles are worth loading). */
export function mintsWithBuyers(tokens: readonly StudyToken[], buys: readonly EarlyBuy[]): string[] {
  const has = new Set(buys.map((b) => b.mint));
  return tokens.filter((t) => has.has(t.mint)).map((t) => t.mint);
}

export function buildStudyInput(
  tokens: readonly StudyToken[],
  buys: readonly EarlyBuy[],
  youngCalmMs: ReadonlyMap<string, number>,
  peakMs: ReadonlyMap<string, number>,
): WalletStudyInput {
  return { tokens, buys, youngCalmMs, peakMs };
}
