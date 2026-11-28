import { ANALYSIS_CHECK_IDS, RISK_REASON_CODES, type Verdict } from '@raijin/shared-contracts';
import type { FollowUpHorizon, OutcomeStatus, Proportion, VerdictRecord } from './contracts';
import type { HorizonOutcome } from './outcome';
import { MIN_SAMPLE_SIZE, proportion } from './stats';

/**
 * Justesse des verdicts à un horizon (docs/ARCHITECTURE.md §16.3). Classe positive : `rug` (défaut)
 * ou `rugOrDead`. Danger = positif prédit, Sain = négatif prédit, Prudence affichée à part. Les
 * issues `unknown` et les verdicts sans issue sont exclus des taux et comptés.
 */

export type PositiveClass = 'rug' | 'rugOrDead';

/** Ce qu'il faut d'un verdict pour le mesurer (un `VerdictRecord`, ou un verdict rejoué). */
export type ScoredVerdict = Pick<VerdictRecord, 'id' | 'verdict' | 'reasonCodes' | 'flaggedChecks'>;

export type KnownOutcome = Exclude<OutcomeStatus, 'unknown'>;

export const VERDICT_ORDER: readonly Verdict[] = ['safe', 'warn', 'danger'];
export const KNOWN_OUTCOMES: readonly KnownOutcome[] = ['rug', 'dead', 'alive'];

export interface AccuracyOptions {
  readonly horizon: FollowUpHorizon;
  readonly positive?: PositiveClass;
  readonly minSample?: number;
}

export interface AccuracyCounts {
  /** Verdicts fournis. */
  readonly records: number;
  /** Verdicts dont l'issue est connue (base de tous les taux). */
  readonly evaluated: number;
  /** Issue `unknown` (prix et liquidité inconnus). */
  readonly unknown: number;
  /** Aucune issue fournie pour ce verdict. */
  readonly missing: number;
  /** Issues positives parmi les évaluées. */
  readonly positives: number;
}

export interface AccuracyReport {
  readonly horizon: FollowUpHorizon;
  readonly positive: PositiveClass;
  readonly counts: AccuracyCounts;
  /** Effectifs verdict × issue connue. */
  readonly matrix: Readonly<Record<Verdict, Readonly<Record<KnownOutcome, number>>>>;
  /** Positifs parmi les Danger. */
  readonly dangerPrecision: Proportion;
  /** Danger parmi les positifs (« part des rugs signalés à l'avance »). */
  readonly dangerRecall: Proportion;
  /** Positifs parmi les Sain (faux « Sain »). */
  readonly falseSafeRate: Proportion;
  /** Positifs parmi les Prudence. */
  readonly cautionPositiveRate: Proportion;
  /** Taux de positifs global (référence du lift). */
  readonly baseRate: Proportion;
}

export function isPositive(status: KnownOutcome, positive: PositiveClass): boolean {
  return status === 'rug' || (positive === 'rugOrDead' && status === 'dead');
}

interface Evaluated {
  readonly item: ScoredVerdict;
  readonly positive: boolean;
}

function partition(
  items: readonly ScoredVerdict[],
  outcomes: ReadonlyMap<string, Pick<HorizonOutcome, 'horizon' | 'status'>>,
  horizon: FollowUpHorizon,
  positive: PositiveClass,
): { evaluated: Evaluated[]; unknown: number; missing: number; statuses: Map<string, KnownOutcome> } {
  const evaluated: Evaluated[] = [];
  const statuses = new Map<string, KnownOutcome>();
  let unknown = 0;
  let missing = 0;
  for (const item of items) {
    const outcome = outcomes.get(item.id);
    if (outcome === undefined) {
      missing += 1;
      continue;
    }
    if (outcome.horizon !== horizon) {
      throw new RangeError(`Issue à ${outcome.horizon} fournie pour l'horizon ${horizon}.`);
    }
    if (outcome.status === 'unknown') {
      unknown += 1;
      continue;
    }
    statuses.set(item.id, outcome.status);
    evaluated.push({ item, positive: isPositive(outcome.status, positive) });
  }
  return { evaluated, unknown, missing, statuses };
}

/** Précision et rappel du Danger, faux Sain, Prudence, matrice et effectifs à un horizon. */
export function computeAccuracy(
  items: readonly ScoredVerdict[],
  outcomes: ReadonlyMap<string, Pick<HorizonOutcome, 'horizon' | 'status'>>,
  options: AccuracyOptions,
): AccuracyReport {
  const positive = options.positive ?? 'rug';
  const minSample = options.minSample ?? MIN_SAMPLE_SIZE;
  const { evaluated, unknown, missing, statuses } = partition(items, outcomes, options.horizon, positive);

  const matrix: Record<Verdict, Record<KnownOutcome, number>> = {
    safe: { rug: 0, dead: 0, alive: 0 },
    warn: { rug: 0, dead: 0, alive: 0 },
    danger: { rug: 0, dead: 0, alive: 0 },
  };
  for (const { item } of evaluated) {
    const status = statuses.get(item.id) as KnownOutcome;
    matrix[item.verdict][status] += 1;
  }

  const rate = (verdict: Verdict) => {
    const group = evaluated.filter((entry) => entry.item.verdict === verdict);
    return proportion(group.filter((entry) => entry.positive).length, group.length, minSample);
  };
  const positives = evaluated.filter((entry) => entry.positive);

  return {
    horizon: options.horizon,
    positive,
    counts: { records: items.length, evaluated: evaluated.length, unknown, missing, positives: positives.length },
    matrix,
    dangerPrecision: rate('danger'),
    dangerRecall: proportion(positives.filter((entry) => entry.item.verdict === 'danger').length, positives.length, minSample),
    falseSafeRate: rate('safe'),
    cautionPositiveRate: rate('warn'),
    baseRate: proportion(positives.length, evaluated.length, minSample),
  };
}

/** Effectif minimal de tokens portant un signal pour le classer (docs/ARCHITECTURE.md §16.3). */
export const MIN_SIGNAL_SUPPORT = 10;

export interface SignalPowerRow {
  readonly kind: 'reason' | 'check';
  /** Code de raison ou identifiant de contrôle. */
  readonly signal: string;
  /** Verdicts évalués portant le signal. */
  readonly support: number;
  /** Taux de positifs parmi les porteurs du signal. */
  readonly withSignal: Proportion;
  /** Taux de positifs parmi les autres. */
  readonly withoutSignal: Proportion;
  /** Taux avec / taux global ; `null` si non classé ou taux global nul. */
  readonly lift: number | null;
  /** Vrai si `support` ≥ support minimal : seul cas où le signal est classé. */
  readonly ranked: boolean;
}

export interface SignalPowerReport {
  readonly horizon: FollowUpHorizon;
  readonly positive: PositiveClass;
  readonly evaluated: number;
  readonly baseRate: Proportion;
  readonly byReason: readonly SignalPowerRow[];
  readonly byCheck: readonly SignalPowerRow[];
}

export interface SignalPowerOptions extends AccuracyOptions {
  readonly minSupport?: number;
}

function sortRows(rows: SignalPowerRow[]): SignalPowerRow[] {
  return rows.sort((a, b) => {
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1;
    const lift = (b.lift ?? -1) - (a.lift ?? -1);
    if (lift !== 0) return lift;
    return b.support - a.support || a.signal.localeCompare(b.signal);
  });
}

/**
 * Pouvoir prédictif de chaque code de raison et de chaque contrôle signalé : taux de positifs avec
 * et sans le signal, lift. Seuls les signaux présents au moins une fois figurent ; un signal porté
 * par moins de `minSupport` verdicts évalués n'est pas classé (lift `null`).
 */
export function signalPower(
  items: readonly ScoredVerdict[],
  outcomes: ReadonlyMap<string, Pick<HorizonOutcome, 'horizon' | 'status'>>,
  options: SignalPowerOptions,
): SignalPowerReport {
  const positive = options.positive ?? 'rug';
  const minSample = options.minSample ?? MIN_SAMPLE_SIZE;
  const minSupport = options.minSupport ?? MIN_SIGNAL_SUPPORT;
  if (!Number.isInteger(minSupport) || minSupport < 1) throw new RangeError('Support minimal invalide.');
  const { evaluated } = partition(items, outcomes, options.horizon, positive);
  const positives = evaluated.filter((entry) => entry.positive).length;
  const baseRate = proportion(positives, evaluated.length, minSample);

  const rowsFor = (kind: SignalPowerRow['kind'], signals: readonly string[], has: (item: ScoredVerdict, signal: string) => boolean) =>
    sortRows(
      signals.flatMap((signal): SignalPowerRow[] => {
        const carriers = evaluated.filter((entry) => has(entry.item, signal));
        if (carriers.length === 0) return [];
        const carrierPositives = carriers.filter((entry) => entry.positive).length;
        const withSignal = proportion(carrierPositives, carriers.length, minSample);
        const withoutSignal = proportion(positives - carrierPositives, evaluated.length - carriers.length, minSample);
        const ranked = carriers.length >= minSupport;
        const lift = ranked && baseRate.value !== null && baseRate.value > 0 && withSignal.value !== null ? withSignal.value / baseRate.value : null;
        return [{ kind, signal, support: carriers.length, withSignal, withoutSignal, lift, ranked }];
      }),
    );

  return {
    horizon: options.horizon,
    positive,
    evaluated: evaluated.length,
    baseRate,
    byReason: rowsFor('reason', RISK_REASON_CODES, (item, code) => (item.reasonCodes as readonly string[]).includes(code)),
    byCheck: rowsFor('check', ANALYSIS_CHECK_IDS, (item, id) => (item.flaggedChecks as readonly string[]).includes(id)),
  };
}
