// « Calme » / « Frénésie » auto-paper wiring of scan-tokens (feat/young-calm, docs/contracts/young-calm.md §3).
// Pure: no I/O, no Date.now(). The predicates live in ./presets.ts (matchesYoungCalm / matchesYoungFrenzy) and the
// plans / exclusions in ./paper-engine.ts (calmFrenzyPlans, calmFrenzyOpenings); this file only bounds what one scan
// reads and sends:
//   - matches of the scan (≤ CALM_FRENZY_MAX_PER_PRESET tokens per preset, scan order = 1 h volume first);
//   - users with auto_paper = true (≤ CALM_FRENZY_MAX_USERS, valid UUIDs, deterministic order);
//   - the existing-positions read is complete (fewer rows than the limit), else nothing is opened (fail closed);
//   - paper_open_position_as arguments (≤ CALM_FRENZY_MAX_RPC per scan, source 'auto_alert', no alert link).
// The RPC re-checks everything (one position per (user, book, mint) forever, 12 h cooldown, caps, balance, token).
import {
  type CalmFrenzyMatch,
  type CalmFrenzyOpening,
  type CalmFrenzyPreset,
  openPositionArgs,
  type OpenPositionAsArgs,
} from './paper-engine.ts';
import { matchesYoungCalm, matchesYoungFrenzy, type PresetToken } from './presets.ts';
import { isSolanaAddress } from './solana.ts';

/** Matching tokens kept per preset and per scan. */
export const CALM_FRENZY_MAX_PER_PRESET = 10;
/** Users with auto_paper = true read per scan (same bound as the alert users). */
export const CALM_FRENZY_MAX_USERS = 25;
/** RPCs sent per scan at most (the rest, if any, is retried at the next scan while the token still matches). */
export const CALM_FRENZY_MAX_RPC = 100;
/** Existing paper_positions rows read per scan; a full page cannot prove absence → nothing opened (fail closed). */
export const CALM_FRENZY_EXISTING_LIMIT = 1000;
/** Wall-time budget of the RPCs of one scan (ms), and RPCs in flight. */
export const CALM_FRENZY_BUDGET_MS = 4_000;
export const CALM_FRENZY_CONCURRENCY = 4;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Young preset matches of the scan, in token order (scan-tokens passes them by 1 h volume, highest first): a token may
 * match one preset at most (the momentum classes are disjoint). ≤ maxPerPreset per preset; invalid mints and
 * duplicate mints are skipped. `tokens` are the alert rows (pair_created_at in epoch ms, known buys / sells only).
 */
export function calmFrenzyMatches(
  tokens: readonly PresetToken[],
  nowMs: number,
  maxPerPreset: number = CALM_FRENZY_MAX_PER_PRESET,
): CalmFrenzyMatch[] {
  if (!Array.isArray(tokens) || !Number.isFinite(nowMs)) return [];
  const cap = Number.isFinite(maxPerPreset) && maxPerPreset > 0 ? Math.floor(maxPerPreset) : 0;
  const counts: Record<CalmFrenzyPreset, number> = { young_calm: 0, young_frenzy: 0 };
  const seen = new Set<string>();
  const out: CalmFrenzyMatch[] = [];
  for (const t of tokens) {
    if (!t || !isSolanaAddress(t.mint) || seen.has(t.mint)) continue;
    const preset: CalmFrenzyPreset | null = matchesYoungCalm(t, nowMs).ok
      ? 'young_calm'
      : matchesYoungFrenzy(t, nowMs).ok
      ? 'young_frenzy'
      : null;
    if (preset === null || counts[preset] >= cap) continue;
    seen.add(t.mint);
    counts[preset]++;
    out.push({ preset, token: { mint: t.mint, price_usd: t.price_usd } });
  }
  return out;
}

/** alert_settings rows { user_id } → distinct valid UUIDs, in row order, ≤ max. */
export function autoPaperUserIds(rows: unknown, max: number = CALM_FRENZY_MAX_USERS): string[] {
  const out: string[] = [];
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (out.length >= max) break;
    const id = typeof row === 'object' && row !== null ? (row as Record<string, unknown>).user_id : null;
    if (typeof id === 'string' && UUID.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * true when the existing-positions read can be trusted: an array strictly shorter than the requested limit (a full
 * page may hide rows, so the "forever" / cooldown exclusions could not be proven).
 */
export const existingReadComplete = (rows: unknown, limit: number = CALM_FRENZY_EXISTING_LIMIT): boolean =>
  Array.isArray(rows) && rows.length < limit;

/** paper_open_position_as arguments of the openings (no alert link), invalid ones dropped, ≤ max. */
export function calmFrenzyRpcArgs(
  openings: readonly CalmFrenzyOpening[],
  max: number = CALM_FRENZY_MAX_RPC,
): OpenPositionAsArgs[] {
  const out: OpenPositionAsArgs[] = [];
  for (const o of Array.isArray(openings) ? openings : []) {
    if (out.length >= max) break;
    const args = o ? openPositionArgs(o.user_id, o.mint, o.plan, null) : null;
    if (args && args.p_entry_mode === 'next_tick' && args.p_strategy === 'all_x2') out.push(args);
  }
  return out;
}
