import { RISK_ENGINE_VERSION } from '@raijin/shared-risk-engine';
import {
  DEFAULT_OUTCOME_THRESHOLDS,
  FOLLOW_UP_HORIZONS,
  type EngineVariant,
  type FollowUpHorizon,
  type FollowUpObservation,
  type OutcomeThresholds,
  type VerdictRecord,
} from './contracts';
import { MIN_SIGNAL_SUPPORT, computeAccuracy, signalPower, type AccuracyReport, type SignalPowerReport } from './accuracy';
import { resolveOutcomes } from './outcome';
import { periodOf, splitChronologically, type Period } from './period';
import { MIN_SAMPLE_SIZE } from './stats';
import { replayVariants, type ReplayReport } from './variant';

/**
 * Rapport complet de l'écran `/justesse` : tout est calculé ici (l'écran n'affiche que ce qui en
 * sort). En phase 8 bis, l'API du banc produit le même rapport depuis `raijin_bench`.
 */

export interface HorizonQuality {
  readonly horizon: FollowUpHorizon;
  /** Observations écartées et verdicts sans observation à cet horizon. */
  readonly coverage: { readonly outOfWindow: number; readonly orphans: number; readonly missingAtHorizon: number };
  /** Classe positive `rug` (vue principale). */
  readonly accuracy: AccuracyReport;
  /** Classe positive `rug` ∪ `dead` (vue secondaire). */
  readonly accuracyRugOrDead: AccuracyReport;
  readonly signals: SignalPowerReport;
  /** Référence et variantes rejouées sur la période de validation (la plus récente). */
  readonly replay: ReplayReport;
}

export interface QualityReport {
  /** Vrai tant que les données viennent de `simulateHistory` (bandeau « Données simulées »). */
  readonly simulated: boolean;
  /** Version du moteur dont les verdicts enregistrés sont mesurés. */
  readonly engineVersion: string;
  /** Verdicts enregistrés par une autre version (exclus des métriques, comptés). */
  readonly otherEngineVersions: number;
  readonly records: number;
  readonly observations: number;
  readonly period: Period | null;
  readonly calibrationPeriod: Period | null;
  readonly validationPeriod: Period | null;
  readonly minSample: number;
  readonly minSupport: number;
  readonly horizons: readonly HorizonQuality[];
}

export interface QualityInput {
  readonly simulated: boolean;
  readonly records: readonly VerdictRecord[];
  readonly observations: readonly FollowUpObservation[];
}

export interface QualityOptions {
  readonly engineVersion?: string;
  readonly thresholds?: OutcomeThresholds;
  readonly calibrationRatio?: number;
  readonly minSample?: number;
  readonly minSupport?: number;
}

export function buildQualityReport(input: QualityInput, variants: readonly EngineVariant[], options: QualityOptions = {}): QualityReport {
  const engineVersion = options.engineVersion ?? RISK_ENGINE_VERSION;
  const minSample = options.minSample ?? MIN_SAMPLE_SIZE;
  const minSupport = options.minSupport ?? MIN_SIGNAL_SUPPORT;
  const thresholds = options.thresholds ?? DEFAULT_OUTCOME_THRESHOLDS;
  const measured = input.records.filter((record) => record.engineVersion === engineVersion);
  const split = splitChronologically(input.records, options.calibrationRatio ?? 0.7);

  const horizons = FOLLOW_UP_HORIZONS.map((horizon): HorizonQuality => {
    const resolved = resolveOutcomes(input.records, input.observations, horizon, thresholds);
    const outcomes = resolved.byRecord;
    return {
      horizon,
      coverage: { outOfWindow: resolved.outOfWindow, orphans: resolved.orphans, missingAtHorizon: resolved.missingAtHorizon },
      accuracy: computeAccuracy(measured, outcomes, { horizon, positive: 'rug', minSample }),
      accuracyRugOrDead: computeAccuracy(measured, outcomes, { horizon, positive: 'rugOrDead', minSample }),
      signals: signalPower(measured, outcomes, { horizon, positive: 'rug', minSample, minSupport }),
      replay: replayVariants(split.validation, outcomes, variants, horizon, { positive: 'rug', minSample }),
    };
  });

  return {
    simulated: input.simulated,
    engineVersion,
    otherEngineVersions: input.records.length - measured.length,
    records: input.records.length,
    observations: input.observations.length,
    period: periodOf(input.records),
    calibrationPeriod: split.calibrationPeriod,
    validationPeriod: split.validationPeriod,
    minSample,
    minSupport,
    horizons,
  };
}
