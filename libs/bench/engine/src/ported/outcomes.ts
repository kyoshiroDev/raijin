// Outcome labelling for the « ×3 minimum » model (feat/x3-model).
// Pure and deterministic: the caller passes nowMs. Rules documented in docs/MODEL.md §Labellisation.
import type { Candle } from './types';
import type { OutcomeLabel } from './x3-types';

const HOUR_MS = 3_600_000;
/** Observation horizon of every label. */
export const OUTCOME_HORIZON_H = 24 * 7;
export const DD_THRESHOLD = 0.5;
/** Default stop of the alert / paper plans: −30 %. */
export const SL30_THRESHOLD = 0.7;
/** Relative tolerance on thresholds so that 0.1 → 0.3 counts as ×3 despite floating point. */
const EPS = 1e-9;

function isValidCandle(c: Candle): boolean {
  if (!Array.isArray(c) || c.length < 5) return false;
  const [ts, o, h, l, cl] = c;
  return (
    [ts, o, h, l, cl].every((x) => typeof x === 'number' && Number.isFinite(x)) &&
    l > 0 && h >= l
  );
}

function emptyLabel(observedHours: number): OutcomeLabel {
  return {
    status: 'pending',
    hit_x2: false,
    hit_x3: false,
    hit_x5: false,
    dd50_first: false,
    max_multiple_7d: 0,
    hours_to_x3: null,
    min_multiple_7d: 0,
    hit_sl30: false,
    x2_before_sl30: false,
    sl30_before_x2: false,
    hours_to_x2: null,
    observed_hours: observedHours,
  };
}

/**
 * Labels one detection from GeckoTerminal candles ([tsSec, o, h, l, c, v]).
 *
 * - Only candles whose open time is ≥ detectedAtMs, < detectedAtMs + 7 d and ≤ nowMs count (candle order in the
 *   input does not matter; invalid candles are skipped). A candle opened before detection is excluded because its
 *   high/low may predate the entry.
 * - hit_xN: some high ≥ N × entry. max_multiple_7d: max high / entry (0 when no candle).
 * - dd50_first: some low ≤ 0.5 × entry strictly before the candle that first reaches ×3, or in that same candle
 *   (intra-candle order unknown → conservative: counted as drawdown first), or at any time when ×3 never happens.
 *   Settled at the first of the two events.
 * - x2_before_sl30 / sl30_before_x2: which of ×2 (high ≥ 2 × entry) and −30 % (low ≤ 0.7 × entry) happened first;
 *   same candle → stop first (conservative). Both false while neither happened. hit_sl30: −30 % at any time.
 * - min_multiple_7d: min low / entry; hours_to_x2: open time of the first ×2 candle − detection, hours.
 * - hours_to_x3: open time of the first ×3 candle − detection, hours (≥ 0).
 * - observed_hours: min(now − detection, 168), ≥ 0.
 * - status 'final' when ×3 is reached, or when 168 h have elapsed AND at least one candle was seen. When final on
 *   ×3, hit_x5 and max_multiple_7d are lower bounds (what was observed so far). Without any candle the label stays
 *   'pending' (no data ≠ no move); the caller decides when to drop such rows.
 * - entry ≤ 0 / not finite, or invalid timestamps: always 'pending' with empty values — the caller must exclude it.
 */
export function labelOutcome(entryPrice: number, detectedAtMs: number, candles: readonly Candle[], nowMs: number): OutcomeLabel {
  if (!Number.isFinite(detectedAtMs) || !Number.isFinite(nowMs)) return emptyLabel(0);
  const observedHours = Math.min(Math.max(0, (nowMs - detectedAtMs) / HOUR_MS), OUTCOME_HORIZON_H);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return emptyLabel(0);

  const horizonEnd = detectedAtMs + OUTCOME_HORIZON_H * HOUR_MS;
  const usable = candles
    .filter(isValidCandle)
    .filter((c) => {
      const ms = c[0] * 1000;
      return ms >= detectedAtMs && ms < horizonEnd && ms <= nowMs;
    })
    .slice()
    .sort((a, b) => a[0] - b[0]);

  const label = emptyLabel(observedHours);
  if (usable.length === 0) return label;

  let maxHigh = 0;
  let minLow = Number.POSITIVE_INFINITY;
  let x3Reached = false;
  let ddSettled = false;
  let x2SlSettled = false;
  for (const c of usable) {
    const high = c[2];
    const low = c[3];
    if (high > maxHigh) maxHigh = high;
    if (low < minLow) minLow = low;
    const slHere = low <= SL30_THRESHOLD * entryPrice * (1 + EPS);
    const x2Here = high >= 2 * entryPrice * (1 - EPS);
    if (slHere) label.hit_sl30 = true;
    if (x2Here && label.hours_to_x2 === null) label.hours_to_x2 = Math.max(0, (c[0] * 1000 - detectedAtMs) / HOUR_MS);
    if (!x2SlSettled && (slHere || x2Here)) {
      x2SlSettled = true;
      if (slHere) label.sl30_before_x2 = true; // includes the same-candle case (conservative)
      else label.x2_before_sl30 = true;
    }
    const ddHere = low <= DD_THRESHOLD * entryPrice * (1 + EPS);
    const x3Here = high >= 3 * entryPrice * (1 - EPS);
    if (!ddSettled && !x3Reached && ddHere) {
      label.dd50_first = true; // includes the same-candle case (conservative)
      ddSettled = true;
    }
    if (!x3Reached && x3Here) {
      x3Reached = true;
      ddSettled = true; // a later drawdown no longer counts
      label.hours_to_x3 = Math.max(0, (c[0] * 1000 - detectedAtMs) / HOUR_MS);
    }
  }

  const multiple = maxHigh / entryPrice;
  label.max_multiple_7d = multiple;
  label.min_multiple_7d = minLow / entryPrice;
  label.hit_x2 = multiple >= 2 * (1 - EPS);
  label.hit_x3 = x3Reached;
  label.hit_x5 = multiple >= 5 * (1 - EPS);
  label.status = x3Reached || observedHours >= OUTCOME_HORIZON_H ? 'final' : 'pending';
  return label;
}
