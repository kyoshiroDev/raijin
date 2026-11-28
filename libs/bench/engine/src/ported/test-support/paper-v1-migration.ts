// Pure mirror of the DATA MIGRATION of supabase/migrations/20261118020000_paper_trading_v2.sql (section 5), used by
// paper_engine_test.ts only (never imported by an Edge Function). Keep both in sync: the SQL is the source of truth,
// this file documents and tests its mapping rules on the same fixtures as the local SQL run.

export type V1Status = 'pending' | 'open' | 'tp_hit' | 'sl_hit' | 'cancelled' | 'expired';

export interface V1Order {
  id: string;
  user_id: string;
  mint: string;
  type: 'limit_entry' | 'market';
  stake_sol: number;
  entry_price: number | null;
  tp_price: number | null;
  sl_price: number | null;
  status: V1Status;
  group_id: string | null;
  source: 'manual' | 'auto';
  expires_at: string;
  fill_price: number | null;
  exit_price: number | null;
  fees_sol: number | null;
  pnl_sol: number | null;
}

export interface V2PositionDraft {
  id: string;
  user_id: string;
  strategy: 'half_x2_rest_x3' | 'custom';
  status: 'pending' | 'open' | 'closed' | 'cancelled' | 'expired';
  stake_sol: number;
  source: 'manual' | 'auto_alert';
  entry_target_price: number;
  sl_price: number;
  custom_tp_price: number | null;
  sl_pct: number;
  pnl_sol: number | null;
  fees_sol: number | null;
}

export interface V2LegDraft {
  id: string;
  position_id: string;
  size_pct: 50 | 100;
  tp_price: number;
  stop_price: number;
  status: 'open' | 'tp_hit' | 'sl_hit';
  exit_price: number | null;
}

export const NO_TP = 1e11;
export const NO_SL = 1e-12;
export const RENT_SOL = 0.00204;

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const sum = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0);
};
const distinct = <T>(xs: T[]) => new Set(xs).size;

/** True when a group is the v1 default strategy (two halves, TP ×2 / ×3) with compatible statuses: merged. */
export function mergeable(group: readonly V1Order[]): boolean {
  if (group.length !== 2) return false;
  const [a, b] = group;
  if (a!.user_id !== b!.user_id || a!.mint !== b!.mint || a!.stake_sol !== b!.stake_sol || a!.type !== b!.type) return false;
  if (a!.source !== b!.source || a!.expires_at !== b!.expires_at) return false;
  if (!group.every((o) => o.entry_price !== null && o.tp_price !== null && o.sl_price !== null)) return false;
  if (a!.entry_price !== b!.entry_price || a!.sl_price !== b!.sl_price || (a!.fill_price ?? -1) !== (b!.fill_price ?? -1)) return false;
  const ratios = group.map((o) => round6((o.tp_price as number) / (o.entry_price as number)));
  if (Math.min(...ratios) !== 2 || Math.max(...ratios) !== 3) return false;
  const all = (pred: (s: V1Status) => boolean) => group.every((o) => pred(o.status));
  return all((s) => s === 'pending') || all((s) => s === 'cancelled') || all((s) => s === 'expired') ||
    all((s) => s === 'open' || s === 'tp_hit' || s === 'sl_hit');
}

function positionStatus(orders: readonly V1Order[]): V2PositionDraft['status'] {
  if (orders.every((o) => o.status === 'pending')) return 'pending';
  if (orders.every((o) => o.status === 'cancelled')) return 'cancelled';
  if (orders.every((o) => o.status === 'expired')) return 'expired';
  if (orders.some((o) => o.status === 'open')) return 'open';
  return 'closed';
}

/**
 * v1 orders → v2 positions + legs + per-user rent credit (book 'main'). `tokenPrice` = public.tokens.price_usd
 * (last entry fallback only).
 */
export function migrateV1Orders(orders: readonly V1Order[], tokenPrice: (mint: string) => number | null = () => null) {
  const groups = new Map<string, V1Order[]>();
  for (const o of orders) {
    const k = o.group_id ?? o.id;
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const buckets: { key: string; merged: boolean; orders: V1Order[] }[] = [];
  for (const [key, g] of groups) {
    if (mergeable(g)) buckets.push({ key, merged: true, orders: g });
    else for (const o of g) buckets.push({ key: o.id, merged: false, orders: [o] });
  }

  const positions: V2PositionDraft[] = [];
  const legs: V2LegDraft[] = [];
  const credits = new Map<string, number>();
  for (const b of buckets) {
    const os = b.orders;
    const first = os[0];
    const maxOf = (f: (o: V1Order) => number | null) => {
      const v = os.map(f).filter((x): x is number => x !== null);
      return v.length ? Math.max(...v) : null;
    };
    const entry = maxOf((o) => o.entry_price);
    const sl = maxOf((o) => o.sl_price);
    const tp = maxOf((o) => o.tp_price);
    const status = positionStatus(os);
    positions.push({
      id: b.key,
      user_id: first!.user_id,
      strategy: b.merged ? 'half_x2_rest_x3' : 'custom',
      status,
      stake_sol: os.reduce((a, o) => a + o.stake_sol, 0),
      source: first!.source === 'auto' ? 'auto_alert' : 'manual',
      entry_target_price:
        entry ?? maxOf((o) => o.fill_price) ?? (sl !== null ? sl / 0.7 : null) ?? (tp !== null ? tp / 2 : null) ??
          tokenPrice(first!.mint) ?? 1e-9,
      sl_price: sl ?? NO_SL,
      custom_tp_price: b.merged ? null : tp ?? NO_TP,
      sl_pct: sl !== null && entry !== null && sl < entry ? Math.min(90, Math.max(1, round6((1 - sl / entry) * 100))) : 30,
      pnl_sol: os.every((o) => o.status === 'tp_hit' || o.status === 'sl_hit') ? sum(os.map((o) => o.pnl_sol)) : null,
      fees_sol: sum(os.map((o) => o.fees_sol)),
    });
    for (const o of os) {
      const closed = o.status === 'tp_hit' || o.status === 'sl_hit';
      legs.push({
        id: o.id,
        position_id: b.key,
        size_pct: b.merged ? 50 : 100,
        tp_price: o.tp_price ?? NO_TP,
        stop_price: o.sl_price ?? NO_SL,
        status: closed ? (o.status as 'tp_hit' | 'sl_hit') : 'open',
        exit_price: closed ? o.exit_price : null,
      });
    }
    // v1 locked one rent per half; v2 returns one per position: credit the extra rent of fully open merged groups.
    if (b.merged && status === 'open' && os.every((o) => o.status === 'open')) {
      credits.set(first!.user_id, (credits.get(first!.user_id) ?? 0) + RENT_SOL);
    }
  }
  return { positions, legs, credits };
}
