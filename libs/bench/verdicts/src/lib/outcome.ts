import {
  DEFAULT_OUTCOME_THRESHOLDS,
  FOLLOW_UP_WINDOWS,
  OUTCOME_EVENTS,
  RUG_EVENTS,
  outcomeThresholdsSchema,
  type FollowUpHorizon,
  type FollowUpObservation,
  type OutcomeClassification,
  type OutcomeEvent,
  type OutcomeStatus,
  type OutcomeThresholds,
  type VerdictRecord,
} from './contracts';

/**
 * Classification des issues d'un verdict (docs/ARCHITECTURE.md §16.1 et §16.2). Fonctions pures :
 * aucune horloge, aucune I/O. Les montants bruts de supply sont comparés en `bigint`.
 */

/** Issue d'un verdict à un horizon, après cumul des observations jusqu'à cet horizon. */
export interface HorizonOutcome {
  readonly horizon: FollowUpHorizon;
  readonly status: OutcomeStatus;
  readonly events: readonly OutcomeEvent[];
}

const HORIZON_RANK: Readonly<Record<FollowUpHorizon, number>> = { '24h': 0, '72h': 1, '7d': 2 };

/**
 * Vrai si l'observation tombe dans la fenêtre de son horizon : entre `verdictAt + délai` et
 * `verdictAt + délai + tolérance` (bornes incluses). Hors fenêtre, elle est écartée.
 */
export function isInWindow(
  record: Pick<VerdictRecord, 'verdictAt'>,
  observation: Pick<FollowUpObservation, 'horizon' | 'observedAt'>,
): boolean {
  const start = Date.parse(record.verdictAt);
  const at = Date.parse(observation.observedAt);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return false;
  const window = FOLLOW_UP_WINDOWS[observation.horizon];
  const opens = start + window.afterMs;
  return at >= opens && at <= opens + window.toleranceMs;
}

/** `value` ≤ (100 − dropPct) % de `reference` (comparaison sans division, bornes incluses). */
function hasCrashed(value: number, reference: number, dropPct: number): boolean {
  return value * 100 <= reference * (100 - dropPct);
}

/** Événements constatés par une observation, dans l'ordre de `OUTCOME_EVENTS`. */
function detectEvents(record: VerdictRecord, observation: FollowUpObservation, thresholds: OutcomeThresholds): OutcomeEvent[] {
  const found = new Set<OutcomeEvent>();
  const baseline = record.baseline;

  if (observation.lpRemoved === true) found.add('LP_REMOVED');
  if (
    baseline.liquidityUsd !== null &&
    baseline.liquidityUsd >= thresholds.liquidityBaselineMinUsd &&
    observation.liquidityUsd !== null &&
    hasCrashed(observation.liquidityUsd, baseline.liquidityUsd, thresholds.crashDropPct)
  ) {
    found.add('LP_REMOVED');
  }

  if (
    baseline.priceUsd !== null &&
    baseline.priceUsd > 0 &&
    observation.priceUsd !== null &&
    hasCrashed(observation.priceUsd, baseline.priceUsd, thresholds.crashDropPct)
  ) {
    found.add('PRICE_CRASH_90');
  }

  if (baseline.supplyRaw !== null && observation.supplyRaw !== null && BigInt(observation.supplyRaw) > BigInt(baseline.supplyRaw)) {
    found.add('MINT_USED');
  }

  if (
    observation.poolFound === false ||
    (observation.liquidityUsd !== null && observation.liquidityUsd < thresholds.deadLiquidityUsd) ||
    (observation.volume24hUsd !== null && observation.volume24hUsd < thresholds.deadVolume24hUsd)
  ) {
    found.add('TOKEN_DEAD');
  }

  return OUTCOME_EVENTS.filter((event) => found.has(event));
}

/** Statut d'un ensemble d'événements (sans observation exploitable : `unknown`). */
function statusOf(events: readonly OutcomeEvent[], informative: boolean): OutcomeStatus {
  if (events.some((event) => RUG_EVENTS.includes(event))) return 'rug';
  if (events.includes('TOKEN_DEAD')) return 'dead';
  return informative ? 'alive' : 'unknown';
}

/**
 * Classe une observation de suivi. Renvoie `null` si elle est hors de la fenêtre de son horizon
 * (écartée, comptée comme manquante). Lève une erreur si elle ne concerne pas ce verdict.
 */
export function classifyObservation(
  record: VerdictRecord,
  observation: FollowUpObservation,
  thresholds: OutcomeThresholds = DEFAULT_OUTCOME_THRESHOLDS,
): OutcomeClassification | null {
  if (observation.recordId !== record.id) {
    throw new RangeError('Observation rattachée à un autre verdict.');
  }
  const limits = outcomeThresholdsSchema.parse(thresholds);
  if (!isInWindow(record, observation)) return null;
  const events = detectEvents(record, observation, limits);
  const informative = observation.priceUsd !== null || observation.liquidityUsd !== null;
  return { recordId: record.id, horizon: observation.horizon, status: statusOf(events, informative), events };
}

/**
 * Issue cumulative à `horizon` : union des événements constatés à cet horizon et aux précédents
 * (un rug à 24 h reste un rug à 7 j). Sans événement, l'issue est celle de l'observation de
 * l'horizon lui-même : `alive` seulement si elle existe et est exploitable, sinon `unknown`
 * (une survie à 24 h ne dit rien de 7 j).
 */
export function resolveOutcomeAt(horizon: FollowUpHorizon, classifications: readonly OutcomeClassification[]): HorizonOutcome {
  const recordIds = new Set(classifications.map((item) => item.recordId));
  if (recordIds.size > 1) {
    throw new RangeError('Classifications de plusieurs verdicts mélangées.');
  }
  const rank = HORIZON_RANK[horizon];
  const upTo = classifications.filter((item) => HORIZON_RANK[item.horizon] <= rank);
  const union = new Set(upTo.flatMap((item) => item.events));
  const events = OUTCOME_EVENTS.filter((event) => union.has(event));
  const aliveAtHorizon = upTo.some((item) => item.horizon === horizon && item.status === 'alive');
  return { horizon, status: statusOf(events, aliveAtHorizon), events };
}

/** Issues de tous les verdicts à un horizon, avec le décompte des observations écartées. */
export interface ResolvedOutcomes {
  readonly horizon: FollowUpHorizon;
  /** Issue par identifiant de verdict (tous les verdicts fournis y figurent, `unknown` si rien). */
  readonly byRecord: ReadonlyMap<string, HorizonOutcome>;
  /** Observations hors fenêtre (écartées, jamais réaffectées). */
  readonly outOfWindow: number;
  /** Observations sans verdict correspondant. */
  readonly orphans: number;
  /** Verdicts sans aucune observation dans la fenêtre de `horizon`. */
  readonly missingAtHorizon: number;
}

/** Classe toutes les observations puis résout l'issue cumulative de chaque verdict à `horizon`. */
export function resolveOutcomes(
  records: readonly VerdictRecord[],
  observations: readonly FollowUpObservation[],
  horizon: FollowUpHorizon,
  thresholds: OutcomeThresholds = DEFAULT_OUTCOME_THRESHOLDS,
): ResolvedOutcomes {
  const byId = new Map(records.map((record) => [record.id, record]));
  const grouped = new Map<string, OutcomeClassification[]>();
  let outOfWindow = 0;
  let orphans = 0;
  for (const observation of observations) {
    const record = byId.get(observation.recordId);
    if (record === undefined) {
      orphans += 1;
      continue;
    }
    const classification = classifyObservation(record, observation, thresholds);
    if (classification === null) {
      outOfWindow += 1;
      continue;
    }
    const list = grouped.get(record.id) ?? [];
    list.push(classification);
    grouped.set(record.id, list);
  }
  const byRecord = new Map<string, HorizonOutcome>();
  let missingAtHorizon = 0;
  for (const record of records) {
    const list = grouped.get(record.id) ?? [];
    if (!list.some((item) => item.horizon === horizon)) missingAtHorizon += 1;
    byRecord.set(record.id, resolveOutcomeAt(horizon, list));
  }
  return { horizon, byRecord, outOfWindow, orphans, missingAtHorizon };
}
