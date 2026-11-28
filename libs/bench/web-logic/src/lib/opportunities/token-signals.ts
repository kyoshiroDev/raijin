// Factual badges of a token (card + detail), replacing the score /100 and the Fibonacci zone (slim-down 2026-11-21).
// Pure, no I/O. The thresholds mirror the « Jeune calme » / « Jeune frénésie » presets of the backend
// (legacy Edge Functions _shared/presets.ts: YOUNG_BASE_RULES, YOUNG_CALM_RULES, YOUNG_FRENZY_RULES, safetyRejection,
// youngLpOk, FLAG_ZONE_BROKEN): if they change there, change them here. These badges describe the token, they are
// not a buy signal.
import type { TokenRow } from '../models/token';
import { formatPercentFr } from '../utils/format';

/** A pair is « jeune » STRICTLY below this age (hours). Same threshold as the backend young-token rules. */
export const YOUNG_MAX_AGE_H = 24;

/** « Calme »: every bound INCLUSIVE. change1h in PERCENT, ratio = (buys_1h + 1) / (sells_1h + 1). */
export const CALM_RULES = { minChange1h: 0, maxChange1h: 100, minRatio: 0.8, maxRatio: 1.3 } as const;

/** « Frénésie »: change1h > 150 % OR ratio > 1.3 (STRICT). Disjoint from « Calme ». */
export const FRENZY_RULES = { change1h: 150, ratio: 1.3 } as const;

/** « Sécurité OK » thresholds: top 10 STRICTLY below 25 %, LP locked ≥ 90 % when known (unknown LP accepted). */
export const SAFETY_RULES = { maxTop10Pct: 25, minLpLockedPct: 90, maxRoundtripPct: 5 } as const;

/** Flag written by the scan when the price is under the 0.786 level of the approximated swing (backend FLAG_ZONE_BROKEN). */
export const FLAG_BROKEN_STRUCTURE = 'Structure cassée';

const HOUR_MS = 3_600_000;
const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Pair age in hours, or null when pair_created_at is missing / unparsable / in the future. */
export function pairAgeHours(pairCreatedAt: string | null | undefined, now: number): number | null {
  if (!pairCreatedAt) return null;
  const t = Date.parse(pairCreatedAt);
  if (!Number.isFinite(t) || t > now) return null;
  return (now - t) / HOUR_MS;
}

/** Known age strictly below 24 h. An unknown age is NOT young. */
export function isYoung(t: Pick<TokenRow, 'pair_created_at'>, now: number): boolean {
  const age = pairAgeHours(t.pair_created_at, now);
  return age !== null && age < YOUNG_MAX_AGE_H;
}

/** (buys + 1) / (sells + 1), or null when either count is unknown or negative. */
export function buySellRatio(buys: number | null | undefined, sells: number | null | undefined): number | null {
  if (!finite(buys) || !finite(sells) || buys < 0 || sells < 0) return null;
  return (buys + 1) / (sells + 1);
}

export type Momentum = 'calm' | 'frenzy';

/**
 * « Calme » / « Frénésie » of a pair younger than 24 h; null otherwise (older or unknown age, unknown change1h or
 * ratio, or « neither », e.g. a negative 1 h or a change between 100 and 150 %).
 */
export function momentumOf(t: Pick<TokenRow, 'pair_created_at' | 'change_1h' | 'buys_1h' | 'sells_1h'>, now: number): Momentum | null {
  if (!isYoung(t, now)) return null;
  const change = t.change_1h;
  const ratio = buySellRatio(t.buys_1h, t.sells_1h);
  if (!finite(change) || ratio === null) return null;
  const c = CALM_RULES;
  if (change >= c.minChange1h && change <= c.maxChange1h && ratio >= c.minRatio && ratio <= c.maxRatio) return 'calm';
  if (change > FRENZY_RULES.change1h || ratio > FRENZY_RULES.ratio) return 'frenzy';
  return null;
}

export const MOMENTUM_LABEL: Record<Momentum, string> = { calm: 'Calme', frenzy: 'Frénésie' };

/** Plain-language explanation of each momentum badge (title / screen readers). */
export const MOMENTUM_HINT: Record<Momentum, string> = {
  calm: 'Paire de moins de 24 h, hausse sur 1 h entre 0 et 100 %, achats et ventes équilibrés (ratio 0,8 à 1,3).',
  frenzy: 'Paire de moins de 24 h, hausse sur 1 h au-delà de 150 % ou achats nettement plus nombreux que les ventes (ratio > 1,3).',
};

type SafetyFields = Pick<
  TokenRow,
  | 'mint_authority_disabled'
  | 'freeze_authority_disabled'
  | 'top10_pct'
  | 'insiders_detected'
  | 'creator_rug_history'
  | 'lp_locked_pct'
  | 'roundtrip_cost_pct'
  | 'flags'
>;

export interface SafetyCheck {
  ok: boolean;
  /** French reasons, in checking order; empty when ok. Unknown mandatory values count as failures. */
  failures: string[];
}

const pct = (v: number): string => formatPercentFr(Math.round(v * 10) / 10);

/**
 * « Sécurité OK » when ALL hold (same rules as the young_calm preset): mint AND freeze authority disabled; top 10
 * holders known and < 25 %; no RugCheck insiders; no creator rug history; LP locked ≥ 90 % when known; round-trip
 * cost known and < 5 % (a failed or costly sell quote can mean a token that cannot be resold); no « Structure cassée »
 * flag (also required by the young_calm alert from phase 2). Unknown authorities / top 10 / cost fail.
 */
export function safetyCheck(t: SafetyFields): SafetyCheck {
  const failures: string[] = [];
  const authority = (label: string, disabled: boolean | null) => {
    if (disabled === null) failures.push(`${label} inconnue`);
    else if (!disabled) failures.push(`${label} active`);
  };
  authority('Autorité de mint', t.mint_authority_disabled);
  authority('Autorité de gel', t.freeze_authority_disabled);
  const top10 = t.top10_pct;
  if (!finite(top10) || top10 < 0) failures.push('Top 10 holders inconnu');
  else if (top10 >= SAFETY_RULES.maxTop10Pct) failures.push(`Top 10 holders à ${pct(top10)} (max ${SAFETY_RULES.maxTop10Pct} %)`);
  if (t.insiders_detected === true) failures.push('Insiders détectés (RugCheck)');
  if (t.creator_rug_history === true) failures.push('Créateur avec des rugs passés (RugCheck)');
  const lp = t.lp_locked_pct;
  if (finite(lp) && lp < SAFETY_RULES.minLpLockedPct) failures.push(`LP verrouillée à ${pct(Math.max(0, lp))} (min ${SAFETY_RULES.minLpLockedPct} %)`);
  const rt = t.roundtrip_cost_pct;
  if (!finite(rt) || rt < 0) failures.push('Coût aller-retour inconnu');
  else if (rt >= SAFETY_RULES.maxRoundtripPct) failures.push(`Coût aller-retour à ${pct(rt)} (max ${SAFETY_RULES.maxRoundtripPct} %)`);
  if (t.flags.includes(FLAG_BROKEN_STRUCTURE)) failures.push(FLAG_BROKEN_STRUCTURE);
  return { ok: failures.length === 0, failures };
}

/** « Sécurité KO : Autorité de mint active ; Top 10 holders à 40 % (max 25 %). » — accessible text of the badge. */
export function safetyDescription(check: SafetyCheck): string {
  if (check.ok) {
    return 'Sécurité OK : mint et freeze désactivés, top 10 sous 25 %, aucun insider ni rug du créateur, LP verrouillée, aller-retour sous 5 %, structure intacte.';
  }
  return `Sécurité KO : ${check.failures.join(' ; ')}.`;
}
