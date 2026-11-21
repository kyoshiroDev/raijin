// Detection probe of scan-tokens (feat/calm-sl-test). Pure orchestration: the I/O is injected, no Date.now().
//
// Why: signal_outcomes.features are frozen at the FIRST sight of a mint (first detection = not in public.tokens before
// the scan). At that instant enrich-tokens has never run on the mint (it only reads public.tokens, one minute later),
// so roundtrip_cost_pct and lp_locked_pct were null on 100 % of the detections (measured: 0 of 1 529 rows). The probe
// measures them IN the detection scan, for the few first-detected young tokens (pair < 24 h: ≈ 0.2 per scan on the
// 16–21/11 data), with the same clients as enrich-tokens:
//   - RugCheck summary (lpLockedPct; 1 call per mint, api.rugcheck.xyz), started in parallel with the Jupiter audits;
//   - Jupiter round trip 0.1 SOL → token → SOL (2 calls per mint), started AFTER the audits on the scan's Jupiter pacer
//     (5 requests / 10 s), so the audits are never delayed.
// The values are point in time (measured now): they feed the flags, the alert / preset rows, the point-in-time snapshot
// columns and the detection features of this scan. public.tokens enrichment columns stay owned by enrich-tokens.
import { isSolanaAddress } from './solana.ts';

/** Round trips (2 Jupiter calls each) per scan at most. */
export const PROBE_MAX_QUOTES = 2;
/** RugCheck summaries per scan at most. */
export const PROBE_MAX_RUGCHECK = 4;
/** Only first detections whose pair is younger than this (hours): the scanner's universe. */
export const PROBE_MAX_AGE_H = 24;

/** The part of a scan metric the probe reads (TokenMetrics). */
export interface ProbeCandidate {
  mint: string;
  ageHours: number | null;
  roundtripCostPct: number | null;
  lpLockedPct: number | null;
}

/** Values measured by the probe. A key absent = not measured this scan (the metric keeps its value). */
export interface ProbeValues {
  roundtripCostPct?: number | null;
  lpLockedPct?: number | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * First-detected young mints, in input order (the caller passes them by activity: 1 h volume first). Nothing when the
 * « existing » read was incomplete (a known token could be mistaken for a new one). Invalid / duplicate mints skipped.
 */
export function probeTargets<T extends ProbeCandidate>(
  items: readonly T[],
  existing: ReadonlySet<string>,
  existingComplete: boolean,
): T[] {
  if (!existingComplete || !Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of items) {
    if (!t || !isSolanaAddress(t.mint) || existing.has(t.mint) || seen.has(t.mint)) continue;
    if (!(finite(t.ageHours) && t.ageHours >= 0 && t.ageHours < PROBE_MAX_AGE_H)) continue;
    seen.add(t.mint);
    out.push(t);
  }
  return out;
}

/** RugCheck summary result as read by the probe (enrich-clients.ts parseRugSummary → RugInfo). */
export interface ProbeRug {
  lpLockedPct: number | null;
}
/** Jupiter round trip as read by the probe (enrich-clients.ts fetchRoundTrip → RoundTrip; undefined = budget stop). */
export interface ProbeRoundTrip {
  roundtripCostPct: number;
}

/**
 * LP lock of the first `max` targets whose LP is unknown, in parallel. A failed / empty summary leaves the key absent
 * (unknown stays unknown); a value outside 0–100 is stored as null. Never throws.
 */
export async function probeLpLocks(
  targets: readonly ProbeCandidate[],
  rug: (mint: string) => Promise<ProbeRug | null>,
  max: number = PROBE_MAX_RUGCHECK,
): Promise<Map<string, ProbeValues>> {
  const out = new Map<string, ProbeValues>();
  const picked = targets.filter((t) => !finite(t.lpLockedPct)).slice(0, Math.max(0, Math.floor(max)));
  await Promise.all(picked.map(async (t) => {
    try {
      const info = await rug(t.mint);
      if (!info) return;
      const lp = info.lpLockedPct;
      out.set(t.mint, { lpLockedPct: finite(lp) && lp >= 0 && lp <= 100 ? lp : null });
    } catch {
      // unknown stays unknown
    }
  }));
  return out;
}

/**
 * Round trip of the first `max` targets whose round trip is unknown, ONE AT A TIME (the caller's fetch is paced). A
 * budget stop (undefined) ends the loop; a failed quote (null) leaves the key absent. A cost outside ±100 % → null.
 * Never throws.
 */
export async function probeRoundTrips(
  targets: readonly ProbeCandidate[],
  roundTrip: (mint: string) => Promise<ProbeRoundTrip | null | undefined>,
  max: number = PROBE_MAX_QUOTES,
): Promise<Map<string, ProbeValues>> {
  const out = new Map<string, ProbeValues>();
  const picked = targets.filter((t) => !finite(t.roundtripCostPct)).slice(0, Math.max(0, Math.floor(max)));
  for (const t of picked) {
    let r: ProbeRoundTrip | null | undefined;
    try {
      r = await roundTrip(t.mint);
    } catch {
      r = null;
    }
    if (r === undefined) break;
    if (r === null) continue;
    const c = r.roundtripCostPct;
    out.set(t.mint, { roundtripCostPct: finite(c) && c >= -100 && c <= 100 ? c : null });
  }
  return out;
}

/**
 * Metrics with the probe values merged in: a value is only written where the metric is unknown (null / non-finite),
 * so a fresh enrich-tokens value is never overwritten. Returns new objects for the touched items only.
 */
export function mergeProbe<T extends ProbeCandidate>(items: readonly T[], ...probes: ReadonlyMap<string, ProbeValues>[]): T[] {
  return items.map((t) => {
    let next: T = t;
    for (const p of probes) {
      const v = p.get(t.mint);
      if (!v) continue;
      if ('roundtripCostPct' in v && !finite(next.roundtripCostPct) && v.roundtripCostPct !== undefined) {
        next = { ...next, roundtripCostPct: v.roundtripCostPct };
      }
      if ('lpLockedPct' in v && !finite(next.lpLockedPct) && v.lpLockedPct !== undefined) {
        next = { ...next, lpLockedPct: v.lpLockedPct };
      }
    }
    return next;
  });
}
