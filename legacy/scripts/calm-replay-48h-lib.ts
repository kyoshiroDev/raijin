// Pure part of scripts/calm-replay-48h.ts (feat/calm-sl-test): replays the LIVE rules of phase 2 on the scan snapshots
// of the last hours, scan by scan, for one user with auto-paper on and alerts enabled (no quiet hours):
//   - « Jeune calme » / « Jeune frénésie » predicates of production (presets.ts matchesYoungCalm / matchesYoungFrenzy)
//     on the POINT-IN-TIME snapshot columns (dex, liquidity, effective liquidity, change 1 h, buys / sells 1 h,
//     authorities, top 10, insiders, round trip, LP) + pair_created_at;
//   - « Structure cassée »: flags are not historised, so it is RECONSTRUCTED with structure.ts structureBroken from the
//     snapshot price path (5 min, 1 h = the stored change_1h, 6 h, 24 h ago; for a pair younger than the window, the
//     first price seen after the pair creation stands for DexScreener's « since creation » change). Coverage reported;
//   - alerts: persistence (a scan of the mint ≤ 5 min before), calmAlertGuard (one alert per calm position episode, 12 h
//     guard otherwise), caps 4 / h and 30 / 24 h (distinct notifications), planNotifications (3 singles + 1 grouped);
//   - books calm_sl30 / calm_sl40 / frenzy_sl30: at every match (≤ 10 per preset per scan), entry at the next snapshot
//     of the mint (next_tick), TP ×2 / SL 30 or 40 % on observed snapshot prices, no stacking per (book, mint), 12 h
//     cooldown per book after a stop, caps 50 active / 200 per 24 h. P&L approximate (no fees / impact).
// Production order inside a scan: alerts first, then the auto-paper openings. No I/O here.
import { MAX_INDIVIDUAL_PER_SCAN, PERSISTENCE_MAX_AGE_MS, planNotifications } from '../supabase/functions/_shared/alerts.ts';
import {
  calmAlertGuard,
  type CalmPositionRef,
  capBudget,
  effectiveLiquidity,
  matchesYoungCalm,
  matchesYoungFrenzy,
  type PresetToken,
} from '../supabase/functions/_shared/presets.ts';
import { structureBroken } from '../supabase/functions/_shared/structure.ts';
import { isSolanaAddress } from '../supabase/functions/_shared/solana.ts';

const MIN = 60_000;
const H = 3_600_000;

const num = (v: unknown): number | null => {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && v.length <= 40 ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const bool = (v: unknown): boolean | null => (v === true || v === 't' || v === 'true' ? true : v === false || v === 'f' || v === 'false' ? false : null);
const ms = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.length > 40) return null;
  if (/^\d{10,16}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** One young PumpSwap scan snapshot (point-in-time columns) + the token's static columns. */
export interface CandidateRow {
  mint: string;
  at: number;
  price: number;
  marketCap: number | null;
  liquidityUsd: number | null;
  liquidityEff: number | null;
  volume1h: number | null;
  change1h: number | null;
  buys1h: number | null;
  sells1h: number | null;
  mad: boolean | null;
  fad: boolean | null;
  top10: number | null;
  insiders: boolean | null;
  roundtrip: number | null;
  lp: number | null;
  dexId: string | null;
  createdMs: number | null;
  /** CURRENT tokens.creator_rug_history (not historised: look-ahead, stated in the report). */
  creatorRugNow: boolean | null;
}

/** One price point of a mint (scan or tracking snapshot). */
export interface PricePoint {
  mint: string;
  at: number;
  price: number;
  source: 'scan' | 'tracking';
}

export function parseCandidate(raw: unknown): CandidateRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const at = ms(r.at);
  const price = num(r.price);
  if (!isSolanaAddress(r.mint) || at === null || price === null || !(price > 0)) return null;
  return {
    mint: r.mint,
    at,
    price,
    marketCap: num(r.mc),
    liquidityUsd: num(r.liq),
    liquidityEff: num(r.liq_eff),
    volume1h: num(r.vol1h),
    change1h: num(r.c1h),
    buys1h: num(r.buys),
    sells1h: num(r.sells),
    mad: bool(r.mad),
    fad: bool(r.fad),
    top10: num(r.top10),
    insiders: bool(r.ins),
    roundtrip: num(r.rt),
    lp: num(r.lp),
    dexId: typeof r.dex === 'string' && r.dex.length <= 32 ? r.dex : null,
    createdMs: num(r.created_ms),
    creatorRugNow: bool(r.crh),
  };
}

export function parsePricePoint(raw: unknown): PricePoint | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const at = ms(r.at);
  const price = num(r.price);
  if (!isSolanaAddress(r.mint) || at === null || price === null || !(price > 0)) return null;
  return { mint: r.mint, at, price, source: r.source === 'tracking' ? 'tracking' : 'scan' };
}

// ---------------------------------------------------------------------------------------------------------------
// « Structure cassée » reconstructed from the price path

export interface StructureAt {
  broken: boolean;
  /** true when the 5 min point and a launch-time (or 6 h / 24 h) point were all found. */
  full: boolean;
}

/** Index of the last point with at ≤ t (binary search on a path sorted by at), −1 if none. */
function lastAtOrBefore(path: readonly PricePoint[], t: number): number {
  let lo = 0;
  let hi = path.length - 1;
  let out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (path[mid].at <= t) {
      out = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return out;
}

/** Price nearest to `target` within ±tol among the path points strictly before `before`; null if none. */
function priceNear(path: readonly PricePoint[], target: number, tol: number, before: number): number | null {
  const i = lastAtOrBefore(path, target + tol);
  let best: PricePoint | null = null;
  for (let k = i; k >= 0 && path[k].at >= target - tol; k--) {
    const p = path[k];
    if (p.at >= before) continue;
    if (!best || Math.abs(p.at - target) < Math.abs(best.at - target)) best = p;
  }
  return best ? best.price : null;
}

/** First price seen at or after the pair creation (and before `before`); null if none. */
function firstAfter(path: readonly PricePoint[], createdMs: number, before: number): { price: number; at: number } | null {
  for (const p of path) {
    if (p.at >= before) break;
    if (p.at >= createdMs - 5 * MIN) return { price: p.price, at: p.at };
  }
  return null;
}

const pct = (now: number, then: number | null): number => (then !== null && then > 0 ? (now / then - 1) * 100 : NaN);

/**
 * structureBroken at snapshot time `at` (price `price`, stored change_1h) from the mint's price path (sorted by at).
 * 5 min = nearest point 3–8 min before; 6 h / 24 h = nearest point within ±20 min, or, when the pair is younger than the
 * window, the first price seen after the pair creation (DexScreener's change of a pair younger than the window is its
 * change since creation). Missing points are skipped (structureBroken ignores non-finite changes).
 */
export function structureAt(
  path: readonly PricePoint[],
  at: number,
  price: number,
  change1h: number | null,
  createdMs: number | null,
): StructureAt {
  const p5 = priceNear(path, at - 5.5 * MIN, 2.5 * MIN, at);
  const launch = createdMs !== null ? firstAfter(path, createdMs, at) : null;
  const launchOk = launch !== null && createdMs !== null && launch.at - createdMs <= 30 * MIN;
  const ageH = createdMs !== null ? (at - createdMs) / H : null;
  const back = (hours: number): number | null =>
    ageH !== null && ageH < hours ? (launch ? launch.price : null) : priceNear(path, at - hours * H, 20 * MIN, at);
  const p6 = back(6);
  const p24 = back(24);
  const broken = structureBroken({
    priceUsd: price,
    change5m: pct(price, p5),
    change1h: change1h ?? NaN,
    change6h: pct(price, p6),
    change24h: pct(price, p24),
  });
  return { broken, full: p5 !== null && launchOk && p6 !== null && p24 !== null };
}

// ---------------------------------------------------------------------------------------------------------------
// Simulation

export type ReplayBook = 'calm_sl30' | 'calm_sl40' | 'frenzy_sl30';
const BOOK_SL: Readonly<Record<ReplayBook, number>> = { calm_sl30: 30, calm_sl40: 40, frenzy_sl30: 30 };
const PRESET_BOOKS = { calm: ['calm_sl30', 'calm_sl40'] as ReplayBook[], frenzy: ['frenzy_sl30'] as ReplayBook[] };
const STAKE = 0.1;
const COOLDOWN_MS = 12 * H;
const PENDING_TTL_MS = 24 * H;
const MAX_PER_PRESET = 10;

interface Position {
  book: ReplayBook;
  mint: string;
  createdAt: number;
  status: 'pending' | 'open' | 'tp' | 'sl' | 'expired';
  fill: number | null;
  closedAt: number | null;
  pnl: number | null;
}

export interface BookStats {
  opened: number;
  tp: number;
  sl: number;
  expired: number;
  active_at_end: number;
  pnl_sol_approx: number;
  refused_caps: number;
}

export interface DayStats {
  calm: {
    matched_tokens: number;
    match_scans: number;
    rejected_by_structure_scans: number;
    alerts_single: number;
    alerts_grouped: number;
    alerted_tokens: number;
    blocked_position_open: number;
    blocked_dedup_12h: number;
    blocked_persistence: number;
    blocked_caps: number;
  };
  frenzy: { matched_tokens: number; match_scans: number; rejected_by_structure_scans: number };
  books: Record<ReplayBook, BookStats>;
  coverage: { young_pumpswap_scan_snapshots: number; ratio_known: number; roundtrip_known: number; structure_full: number };
  /** First failing « Jeune calme » rule per young PumpSwap scan snapshot (matchesYoungCalm reason), 'ok' = match. */
  calm_first_failure: Record<string, number>;
}

export interface ReplayOptions {
  fromMs: number;
  toMs: number;
  /** Apply the « Structure cassée » rule (false = phase-1 rules, for comparison). */
  structure: boolean;
}

const emptyBook = (): BookStats => ({ opened: 0, tp: 0, sl: 0, expired: 0, active_at_end: 0, pnl_sol_approx: 0, refused_caps: 0 });
const emptyDay = (): DayStats => ({
  calm: {
    matched_tokens: 0, match_scans: 0, rejected_by_structure_scans: 0, alerts_single: 0, alerts_grouped: 0, alerted_tokens: 0,
    blocked_position_open: 0, blocked_dedup_12h: 0, blocked_persistence: 0, blocked_caps: 0,
  },
  frenzy: { matched_tokens: 0, match_scans: 0, rejected_by_structure_scans: 0 },
  books: { calm_sl30: emptyBook(), calm_sl40: emptyBook(), frenzy_sl30: emptyBook() },
  coverage: { young_pumpswap_scan_snapshots: 0, ratio_known: 0, roundtrip_known: 0, structure_full: 0 },
  calm_first_failure: {},
});
const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** PresetToken of a candidate snapshot (point-in-time values; creator rug history = current value). */
export function presetTokenOf(c: CandidateRow, structure: boolean | null): PresetToken {
  return {
    mint: c.mint,
    symbol: '',
    dex_id: c.dexId ?? '',
    market_cap: c.marketCap ?? 0,
    flags: [],
    mint_authority_disabled: c.mad,
    freeze_authority_disabled: c.fad,
    price_usd: c.price,
    roundtrip_cost_pct: c.roundtrip,
    insiders_detected: c.insiders,
    creator_rug_history: c.creatorRugNow,
    liquidity_usd: c.liquidityUsd,
    liquidity_effective_usd: c.liquidityEff,
    change_1h: c.change1h,
    top10_pct: c.top10,
    pair_created_at: c.createdMs,
    buys_1h: c.buys1h,
    sells_1h: c.sells1h,
    lp_locked_pct: c.lp,
    volume_1h: c.volume1h,
    structure_broken: structure,
  };
}

export interface ReplayResult {
  per_day: Record<string, DayStats>;
  totals: DayStats;
}

/**
 * Scan-by-scan replay (see the file header). `candidates` = young PumpSwap scan snapshots (any order); `prices` = every
 * snapshot price of those mints (scan + tracking, any order) from at least 24 h before `fromMs` to the end.
 */
export function replay(candidates: readonly CandidateRow[], prices: readonly PricePoint[], opts: ReplayOptions): ReplayResult {
  const paths = new Map<string, PricePoint[]>();
  for (const p of prices) {
    const list = paths.get(p.mint) ?? [];
    list.push(p);
    paths.set(p.mint, list);
  }
  for (const list of paths.values()) list.sort((a, b) => a.at - b.at);
  const byTime = new Map<number, CandidateRow[]>();
  for (const c of candidates) {
    if (c.at < opts.fromMs || c.at > opts.toMs) continue;
    const list = byTime.get(c.at) ?? [];
    list.push(c);
    byTime.set(c.at, list);
  }
  const pricesByTime = new Map<number, PricePoint[]>();
  for (const p of prices) {
    if (p.at < opts.fromMs) continue;
    const list = pricesByTime.get(p.at) ?? [];
    list.push(p);
    pricesByTime.set(p.at, list);
  }
  const times = [...new Set([...byTime.keys(), ...pricesByTime.keys()])].sort((a, b) => a - b);

  const perDay: Record<string, DayStats> = {};
  const day = (t: number): DayStats => (perDay[dayOf(t)] ??= emptyDay());
  const seenCalm = new Map<string, Set<string>>();
  const seenFrenzy = new Map<string, Set<string>>();
  const alertedTokens = new Map<string, Set<string>>();
  const positions: Position[] = [];
  const lastAlert = new Map<string, number>();
  const notifications: number[] = []; // send times of distinct notifications

  for (const t of times) {
    // 1. Paper engine on the prices of this instant (fills of the pending next_tick entries, TP / SL, expiry).
    for (const p of pricesByTime.get(t) ?? []) {
      for (const pos of positions) {
        if (pos.mint !== p.mint) continue;
        if (pos.status === 'pending') {
          if (t - pos.createdAt >= PENDING_TTL_MS) {
            pos.status = 'expired';
            pos.closedAt = t;
            day(t).books[pos.book].expired++;
          } else if (p.at > pos.createdAt) {
            pos.status = 'open';
            pos.fill = p.price;
          }
          continue;
        }
        if (pos.status !== 'open' || pos.fill === null) continue;
        const sl = pos.fill * (1 - BOOK_SL[pos.book] / 100);
        const hitTp = p.price >= pos.fill * 2;
        const hitSl = p.price <= sl;
        if (hitTp || hitSl) {
          pos.status = hitSl ? 'sl' : 'tp';
          pos.closedAt = t;
          pos.pnl = STAKE * (p.price / pos.fill - 1);
          const b = day(t).books[pos.book];
          if (hitSl) b.sl++;
          else b.tp++;
          b.pnl_sol_approx += pos.pnl;
        }
      }
    }

    // 2. Candidates of this scan: predicates (with the reconstructed structure).
    const group = (byTime.get(t) ?? []).slice().sort((a, b) =>
      (b.volume1h ?? -Infinity) - (a.volume1h ?? -Infinity) ||
      (effectiveLiquidity(presetTokenOf(b, null)) ?? -Infinity) - (effectiveLiquidity(presetTokenOf(a, null)) ?? -Infinity) ||
      (a.mint < b.mint ? -1 : 1)
    );
    const calm: CandidateRow[] = [];
    const frenzy: CandidateRow[] = [];
    for (const c of group) {
      const d = day(t);
      d.coverage.young_pumpswap_scan_snapshots++;
      if (c.buys1h !== null && c.sells1h !== null) d.coverage.ratio_known++;
      if (c.roundtrip !== null) d.coverage.roundtrip_known++;
      const s = structureAt(paths.get(c.mint) ?? [], c.at, c.price, c.change1h, c.createdMs);
      if (s.full) d.coverage.structure_full++;
      const tokNoStruct = presetTokenOf(c, null);
      const tok = presetTokenOf(c, opts.structure ? s.broken : null);
      const calmMatch = matchesYoungCalm(tok, t);
      const calmOk = calmMatch.ok;
      const reason = calmMatch.ok ? 'ok' : calmMatch.reason;
      d.calm_first_failure[reason] = (d.calm_first_failure[reason] ?? 0) + 1;
      const frenzyOk = matchesYoungFrenzy(tok, t).ok;
      if (!calmOk && matchesYoungCalm(tokNoStruct, t).ok) d.calm.rejected_by_structure_scans++;
      if (!frenzyOk && matchesYoungFrenzy(tokNoStruct, t).ok) d.frenzy.rejected_by_structure_scans++;
      if (calmOk) {
        calm.push(c);
        d.calm.match_scans++;
        const set = seenCalm.get(dayOf(t)) ?? new Set();
        set.add(c.mint);
        seenCalm.set(dayOf(t), set);
      } else if (frenzyOk) {
        frenzy.push(c);
        d.frenzy.match_scans++;
        const set = seenFrenzy.get(dayOf(t)) ?? new Set();
        set.add(c.mint);
        seenFrenzy.set(dayOf(t), set);
      }
    }

    // 3. Alerts (before the openings of this scan).
    if (calm.length > 0) {
      const d = day(t);
      const alertable: CandidateRow[] = [];
      for (const c of calm) {
        const refs: CalmPositionRef[] = positions
          .filter((p) => p.mint === c.mint && (p.book === 'calm_sl30' || p.book === 'calm_sl40'))
          .map((p) => ({ createdAtMs: p.createdAt, active: p.status === 'pending' || p.status === 'open' }));
        const guard = calmAlertGuard(lastAlert.get(c.mint), refs, t);
        if (guard === 'position_open') {
          d.calm.blocked_position_open++;
          continue;
        }
        if (guard === 'dedup') {
          d.calm.blocked_dedup_12h++;
          continue;
        }
        const path = paths.get(c.mint) ?? [];
        const i = lastAtOrBefore(path, t - 1);
        let persistent = false;
        for (let k = i; k >= 0 && path[k].at >= t - PERSISTENCE_MAX_AGE_MS; k--) {
          if (path[k].source === 'scan' && path[k].at < t) {
            persistent = true;
            break;
          }
        }
        if (!persistent) {
          d.calm.blocked_persistence++;
          continue;
        }
        alertable.push(c);
      }
      const sentHour = notifications.filter((x) => t - x >= 0 && t - x < H).length;
      const sentDay = notifications.filter((x) => t - x >= 0 && t - x < 24 * H).length;
      const plan = planNotifications(alertable.map((c) => presetTokenOf(c, null)), capBudget(sentHour, sentDay));
      d.calm.blocked_caps += alertable.length - plan.individual.length - (plan.grouped ? plan.grouped.mints.length : 0);
      const set = alertedTokens.get(dayOf(t)) ?? new Set();
      for (const a of plan.individual) {
        notifications.push(t);
        lastAlert.set(a.mint, t);
        set.add(a.mint);
        d.calm.alerts_single++;
      }
      if (plan.grouped) {
        notifications.push(t);
        d.calm.alerts_grouped++;
        for (const m of plan.grouped.mints) {
          lastAlert.set(m, t);
          set.add(m);
        }
      }
      alertedTokens.set(dayOf(t), set);
    }

    // 4. Auto-paper openings (≤ 10 per preset per scan, by 1 h volume), every match, independent of alerts.
    const open = (rows: CandidateRow[], books: ReplayBook[]) => {
      for (const c of rows.slice(0, MAX_PER_PRESET)) {
        for (const book of books) {
          const mine = positions.filter((p) => p.book === book && p.mint === c.mint);
          if (mine.some((p) => p.status === 'pending' || p.status === 'open')) continue;
          if (mine.some((p) => p.status === 'sl' && p.closedAt !== null && t - p.closedAt < COOLDOWN_MS)) continue;
          const active = positions.filter((p) => p.status === 'pending' || p.status === 'open').length;
          const recent = positions.filter((p) => t - p.createdAt < 24 * H).length;
          if (active >= 50 || recent >= 200) {
            day(t).books[book].refused_caps++;
            continue;
          }
          positions.push({ book, mint: c.mint, createdAt: t, status: 'pending', fill: null, closedAt: null, pnl: null });
          day(t).books[book].opened++;
        }
      }
    };
    open(calm, PRESET_BOOKS.calm);
    open(frenzy, PRESET_BOOKS.frenzy);
  }

  for (const [d, s] of seenCalm) (perDay[d] ??= emptyDay()).calm.matched_tokens = s.size;
  for (const [d, s] of seenFrenzy) (perDay[d] ??= emptyDay()).frenzy.matched_tokens = s.size;
  for (const [d, s] of alertedTokens) (perDay[d] ??= emptyDay()).calm.alerted_tokens = s.size;
  const lastDay = times.length > 0 ? dayOf(times[times.length - 1]) : null;
  if (lastDay) {
    for (const p of positions) if (p.status === 'pending' || p.status === 'open') perDay[lastDay].books[p.book].active_at_end++;
  }
  for (const s of Object.values(perDay)) {
    for (const b of Object.values(s.books)) b.pnl_sol_approx = Math.round(b.pnl_sol_approx * 1e6) / 1e6;
  }

  // Totals (distinct tokens over the whole window, not the sum of the days).
  const totals = emptyDay();
  for (const s of Object.values(perDay)) {
    for (const k of Object.keys(totals.calm) as (keyof DayStats['calm'])[]) totals.calm[k] += s.calm[k];
    totals.frenzy.match_scans += s.frenzy.match_scans;
    totals.frenzy.rejected_by_structure_scans += s.frenzy.rejected_by_structure_scans;
    for (const b of Object.keys(totals.books) as ReplayBook[]) {
      for (const k of Object.keys(totals.books[b]) as (keyof BookStats)[]) totals.books[b][k] += s.books[b][k];
    }
    for (const k of Object.keys(totals.coverage) as (keyof DayStats['coverage'])[]) totals.coverage[k] += s.coverage[k];
    for (const [k, v] of Object.entries(s.calm_first_failure)) totals.calm_first_failure[k] = (totals.calm_first_failure[k] ?? 0) + v;
  }
  totals.calm.matched_tokens = new Set([...seenCalm.values()].flatMap((s) => [...s])).size;
  totals.frenzy.matched_tokens = new Set([...seenFrenzy.values()].flatMap((s) => [...s])).size;
  totals.calm.alerted_tokens = new Set([...alertedTokens.values()].flatMap((s) => [...s])).size;
  for (const b of Object.values(totals.books)) b.pnl_sol_approx = Math.round(b.pnl_sol_approx * 1e6) / 1e6;
  return { per_day: Object.fromEntries(Object.entries(perDay).sort(([a], [b]) => (a < b ? -1 : 1))), totals };
}

/** Kept for the report: the per-scan individual cap of production. */
export const REPLAY_MAX_SINGLES_PER_SCAN = MAX_INDIVIDUAL_PER_SCAN;
