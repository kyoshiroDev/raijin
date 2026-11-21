// Pure part of scripts/young-calm-replay.ts (feat/young-calm): classify each scan detection (signal_outcomes) AT
// DETECTION as « Jeune calme » / « Jeune frénésie » with the production rules (backtest.ts youngDetectionFailures +
// presets.ts youngMomentumClass), and count candidates per day / narrative, exclusions per criterion and OHLCV label
// outcomes. No I/O. Safety (authorities, top 10) is NOT historised: the « avec sécurité connue » variant uses the
// CURRENT public.tokens values (look-ahead bias, stated in the output).
import {
  detectionFromRow,
  type DetectionInput,
  type YoungDetectionFailure,
  youngDetectionFailures,
} from '../supabase/functions/_shared/backtest.ts';
import { SAFETY_RULES, YOUNG_BASE_RULES, type YoungMomentum, youngMomentumClass } from '../supabase/functions/_shared/presets.ts';

export interface ReplayRow {
  det: DetectionInput;
  /** UTC day of the detection, YYYY-MM-DD. */
  day: string;
  group: 'gta' | 'other';
  failures: YoungDetectionFailure[];
  /** Momentum class at detection (unknown when change_1h or the ratio is unknown). */
  momentum: YoungMomentum;
  /**
   * Current public.tokens safety (look-ahead): authorities revoked, top10 < 25 %, no insiders / creator rug, and the
   * current round trip < 5 % when known.
   */
  safetyNow: 'ok' | 'fail' | 'unknown';
  /** Current tokens.lp_locked_pct (look-ahead), for the LP comparison only. */
  lpNow: number | null;
  /** OHLCV label of the detection: 'x2' (x2_before_sl30), 'sl' (sl30_before_x2), 'neither' (labelled, no hit), null = not labelled. */
  label: 'x2' | 'sl' | 'neither' | null;
}

const num = (v: unknown): number | null => {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && v.length <= 40 ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const bool = (v: unknown): boolean | null => (v === true || v === 't' || v === 'true' ? true : v === false || v === 'f' || v === 'false' ? false : null);

/**
 * One CLI row { mint, detected_at, entry_*, features (jsonb or JSON text), narrative, created_ms, mad, fad, top10,
 * ins, crh, lp_now, x2, sl, labelled } → ReplayRow, or null. Pair age: features.log_age_h, else tokens.pair_created_at
 * vs detected_at (a past fact).
 */
export function replayRow(raw: unknown): ReplayRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  let features = r.features;
  if (typeof features === 'string' && features.length <= 16_384) {
    try {
      features = JSON.parse(features);
    } catch {
      features = null;
    }
  }
  const det = detectionFromRow('signal_outcomes', { ...r, features });
  if (!det) return null;
  if (det.pairAgeH === null) {
    const created = num(r.created_ms);
    if (created !== null && created > 0 && created <= det.detectedAtMs) det.pairAgeH = (det.detectedAtMs - created) / 3_600_000;
  }
  const mad = bool(r.mad);
  const fad = bool(r.fad);
  const top10 = num(r.top10);
  let safetyNow: ReplayRow['safetyNow'];
  const rtNow = num(r.rt_now);
  if (
    mad === false || fad === false || bool(r.ins) === true || bool(r.crh) === true ||
    (top10 !== null && top10 >= SAFETY_RULES.maxTop10Pct) || (rtNow !== null && rtNow >= YOUNG_BASE_RULES.maxRoundtripPct)
  ) {
    safetyNow = 'fail';
  } else if (mad === true && fad === true && top10 !== null && top10 >= 0) {
    safetyNow = 'ok';
  } else {
    safetyNow = 'unknown';
  }
  const x2 = bool(r.x2);
  const sl = bool(r.sl);
  const labelled = bool(r.labelled) === true || x2 !== null || sl !== null;
  return {
    det,
    day: new Date(det.detectedAtMs).toISOString().slice(0, 10),
    group: det.narrative === 'GTA' ? 'gta' : 'other',
    failures: youngDetectionFailures(det),
    momentum: youngMomentumClass(det.change1h, det.buySellRatio1h),
    safetyNow,
    lpNow: num(r.lp_now),
    label: !labelled ? null : x2 === true ? 'x2' : sl === true ? 'sl' : 'neither',
  };
}

export interface Outcome {
  labelled: number;
  x2_before_sl30: number;
  sl30_before_x2: number;
  neither: number;
  /** x2 / labelled, null when nothing is labelled. */
  x2_rate: number | null;
}

const outcome = (rows: readonly ReplayRow[]): Outcome => {
  const l = rows.filter((r) => r.label !== null);
  const x2 = l.filter((r) => r.label === 'x2').length;
  return {
    labelled: l.length,
    x2_before_sl30: x2,
    sl30_before_x2: l.filter((r) => r.label === 'sl').length,
    neither: l.filter((r) => r.label === 'neither').length,
    x2_rate: l.length > 0 ? Math.round((x2 / l.length) * 1000) / 1000 : null,
  };
};

export interface PresetReport {
  /** Candidates without any safety check (authorities / top10 not historised). */
  sans_securite: { total: number; per_day: Record<string, number>; gta: number; other: number; outcome: Outcome; outcome_gta: Outcome; outcome_other: Outcome };
  /** Same, keeping only tokens whose CURRENT safety is known and OK (look-ahead bias). */
  avec_securite_connue_biais: { total: number; per_day: Record<string, number>; gta: number; other: number; safety_unknown_dropped: number; safety_fail_dropped: number; outcome: Outcome };
  /** Candidates on every rule except LP that the LP ≥ 90 % rule removes (LP at detection, features), and with today's LP. */
  lp_rule_removes: { at_detection: number; with_current_lp: number };
}

const perDay = (rows: readonly ReplayRow[], days: readonly string[]): Record<string, number> =>
  Object.fromEntries(days.map((d) => [d, rows.filter((r) => r.day === d).length]));

function presetReport(rows: readonly ReplayRow[], want: 'calm' | 'frenzy', days: readonly string[]): PresetReport {
  const cand = rows.filter((r) => r.failures.length === 0 && r.momentum === want);
  const safe = cand.filter((r) => r.safetyNow === 'ok');
  const noLp = rows.filter((r) => r.momentum === want && r.failures.length > 0 && r.failures.every((f) => f === 'lp'));
  const lpNowRemoves = cand.filter((r) => r.lpNow !== null && r.lpNow < YOUNG_BASE_RULES.minLpLockedPct).length;
  return {
    sans_securite: {
      total: cand.length,
      per_day: perDay(cand, days),
      gta: cand.filter((r) => r.group === 'gta').length,
      other: cand.filter((r) => r.group === 'other').length,
      outcome: outcome(cand),
      outcome_gta: outcome(cand.filter((r) => r.group === 'gta')),
      outcome_other: outcome(cand.filter((r) => r.group === 'other')),
    },
    avec_securite_connue_biais: {
      total: safe.length,
      per_day: perDay(safe, days),
      gta: safe.filter((r) => r.group === 'gta').length,
      other: safe.filter((r) => r.group === 'other').length,
      safety_unknown_dropped: cand.filter((r) => r.safetyNow === 'unknown').length,
      safety_fail_dropped: cand.filter((r) => r.safetyNow === 'fail').length,
      outcome: outcome(safe),
    },
    lp_rule_removes: { at_detection: noLp.length, with_current_lp: lpNowRemoves },
  };
}

export interface ReplayReport {
  window: { from: string; to: string; hours: number };
  detections: number;
  /** Detections with a known pair age < 24 h. */
  young: number;
  /** Among young detections: how many fail each base criterion (independently; a detection can fail several). */
  exclusions_young: Record<YoungDetectionFailure, number>;
  /** Among young detections: round trip unknown at detection (accepted, not a failure). */
  roundtrip_unknown_at_detection: number;
  /** Among young detections passing every base rule: momentum class at detection. */
  momentum_young_base_ok: Record<YoungMomentum, number>;
  /** Among ALL young detections: momentum class (base rules ignored), with OHLCV outcomes — compare with the user's 201. */
  momentum_young_all: Record<YoungMomentum, { n: number; outcome: Outcome }>;
  young_calm: PresetReport;
  young_frenzy: PresetReport;
  notes: string[];
}

const FAILURES: readonly YoungDetectionFailure[] = ['age', 'dex', 'liquidity', 'roundtrip', 'momentum_unknown', 'rug', 'lp'];
const CLASSES: readonly YoungMomentum[] = ['calm', 'frenzy', 'neither', 'unknown'];

/** Full report from the parsed rows of the window [fromMs, toMs). */
export function buildReplayReport(rows: readonly ReplayRow[], fromMs: number, toMs: number): ReplayReport {
  const inWin = rows.filter((r) => r.det.detectedAtMs >= fromMs && r.det.detectedAtMs < toMs);
  const days: string[] = [];
  for (let d = Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), new Date(fromMs).getUTCDate()); d < toMs; d += 86_400_000) {
    days.push(new Date(d).toISOString().slice(0, 10));
  }
  const young = inWin.filter((r) => !r.failures.includes('age'));
  const exclusions = Object.fromEntries(FAILURES.map((f) => [f, young.filter((r) => r.failures.includes(f)).length])) as Record<YoungDetectionFailure, number>;
  const baseOk = young.filter((r) => r.failures.length === 0);
  return {
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), hours: Math.round((toMs - fromMs) / 3_600_000) },
    detections: inWin.length,
    young: young.length,
    exclusions_young: exclusions,
    roundtrip_unknown_at_detection: young.filter((r) => r.det.roundtripPct === null).length,
    momentum_young_base_ok: Object.fromEntries(CLASSES.map((c) => [c, baseOk.filter((r) => r.momentum === c).length])) as Record<YoungMomentum, number>,
    momentum_young_all: Object.fromEntries(CLASSES.map((c) => {
      const list = young.filter((r) => r.momentum === c);
      return [c, { n: list.length, outcome: outcome(list) }];
    })) as Record<YoungMomentum, { n: number; outcome: Outcome }>,
    young_calm: presetReport(inWin, 'calm', days),
    young_frenzy: presetReport(inWin, 'frenzy', days),
    notes: [
      'Rejeu à la détection (signal_outcomes = 1re détection du scan par mint) : âge (features.log_age_h, sinon tokens.pair_created_at), dex / liquidité effective / coût d\'entrée (entry_*), change_1h et ratio achats/ventes 1 h (features), LP et RugCheck insiders / créateur (features à la détection).',
      'Coût d\'aller-retour : mesuré par enrich-tokens APRÈS la 1re détection, donc inconnu à la détection (voir roundtrip_unknown_at_detection) → accepté (règle lab-v2) ; la variante « avec sécurité » applique le coût ACTUEL de public.tokens quand il est connu.',
      'Autorités mint / freeze et top 10 ne sont PAS historisés : « sans_securite » les ignore ; « avec_securite_connue_biais » utilise les valeurs ACTUELLES de public.tokens (biais : un token mort depuis peut avoir changé, un token toujours suivi est mieux renseigné).',
      'Une seule détection par mint (la première) : un token devenu « calme » plus tard dans sa vie n\'est pas compté ici (le mode événement du laboratoire le verra, à partir des snapshots écrits après le déploiement).',
      'Les snapshots antérieurs à feat/young-calm n\'ont ni buys_1h / sells_1h, ni liquidity_effective_usd, ni lp_locked_pct : aucun rejeu par snapshot n\'est possible sur cette période.',
      'Étiquettes OHLCV : x2_before_sl30 / sl30_before_x2 quand la détection est étiquetée ; « neither » = étiquetée sans ×2 ni −30 % dans la fenêtre. Petits effectifs : indicatif, pas une preuve.',
      'Jours en UTC.',
    ],
  };
}
