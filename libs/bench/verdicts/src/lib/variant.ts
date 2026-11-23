import { RISK_FACTS_VERSION, type RiskAssessment, type Verdict } from '@raijin/shared-contracts';
import {
  DEFAULT_RISK_ENGINE_CONFIG,
  createRiskEngine,
  resolveRiskEngineConfig,
  type EvaluateRisk,
  type RiskEngineConfig,
} from '@raijin/shared-risk-engine';
import {
  REFERENCE_VARIANT_ID,
  engineVariantSchema,
  variantEngineVersion,
  type EngineVariant,
  type FollowUpHorizon,
  type VerdictRecord,
} from './contracts';
import {
  computeAccuracy,
  isPositive,
  type AccuracyReport,
  type PositiveClass,
  type ScoredVerdict,
} from './accuracy';
import type { HorizonOutcome } from './outcome';
import { MIN_SAMPLE_SIZE } from './stats';

/**
 * Variantes du moteur (docs/ARCHITECTURE.md §16.4) : surcharges validées de `RiskEngineConfig`,
 * version `<RISK_ENGINE_VERSION>-variante.<id>`, empreinte FNV-1a, rejeu côte à côte avec le
 * moteur de référence. Le banc ne modifie jamais le moteur de Raijin : une variante n'y entre que
 * par une PR qui change `DEFAULT_RISK_ENGINE_CONFIG` et la version (docs/SCORING.md).
 */

/** Clés numériques de `RiskEngineConfig` qu'une variante peut surcharger. */
export const OVERRIDABLE_CONFIG_KEYS: readonly string[] = Object.entries(DEFAULT_RISK_ENGINE_CONFIG)
  .filter(([, value]) => typeof value === 'number')
  .map(([key]) => key)
  .sort();

export interface ResolvedVariant {
  readonly id: string;
  readonly label: string;
  readonly version: string;
  readonly config: RiskEngineConfig;
  /** FNV-1a 32 bits (8 caractères hexadécimaux) du JSON à clés triées de `config`. */
  readonly fingerprint: string;
}

/** JSON déterministe : clés d'objet triées à toute profondeur, ordre des tableaux conservé. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Octets UTF-8 d'une chaîne (sans `TextEncoder`, absent des API ES pures). */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

/** FNV-1a 32 bits, en hexadécimal sur 8 caractères. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of utf8Bytes(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Empreinte d'une configuration résolue (indépendante de l'ordre des clés). */
export function configFingerprint(config: RiskEngineConfig): string {
  return fnv1a32(stableStringify(config));
}

/** Moteur de référence : configuration par défaut, version publiée. */
export function resolveReference(): ResolvedVariant {
  const config = resolveRiskEngineConfig();
  return { id: REFERENCE_VARIANT_ID, label: 'Moteur actuel', version: config.version, config, fingerprint: configFingerprint(config) };
}

/**
 * Valide une variante et résout sa configuration. Refuse un identifiant invalide ou réservé, une
 * clé qui n'est pas un seuil numérique de `RiskEngineConfig` (version, listes, poids hors
 * `reasonWeights`) et toute valeur refusée par `resolveRiskEngineConfig`.
 */
export function resolveVariant(variant: EngineVariant): ResolvedVariant {
  const parsed = engineVariantSchema.parse(variant);
  const unknown = Object.keys(parsed.overrides).filter((key) => !OVERRIDABLE_CONFIG_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new RangeError(`Surcharge inconnue de la configuration du moteur : ${unknown.join(', ')}.`);
  }
  const version = variantEngineVersion(parsed.id);
  const config = resolveRiskEngineConfig({
    ...(parsed.overrides as Partial<RiskEngineConfig>),
    ...(parsed.reasonWeights === undefined ? {} : { reasonWeights: parsed.reasonWeights }),
    version,
  });
  return { id: parsed.id, label: parsed.label, version, config, fingerprint: configFingerprint(config) };
}

/** Verdict rejoué sous une forme mesurable (contrôles en `warn` ou `danger`). */
export function toScoredVerdict(id: string, assessment: RiskAssessment): ScoredVerdict {
  return {
    id,
    verdict: assessment.verdict,
    reasonCodes: [...new Set(assessment.reasons.map((reason) => reason.code))],
    flaggedChecks: assessment.checks.filter((check) => check.status === 'warn' || check.status === 'danger').map((check) => check.id),
  };
}

export interface ReplaySide {
  readonly id: string;
  readonly label: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly accuracy: AccuracyReport;
}

export interface VerdictChanges {
  /** Effectifs de → vers (référence → variante), diagonale comprise. */
  readonly matrix: Readonly<Record<Verdict, Readonly<Record<Verdict, number>>>>;
  /** Verdicts différents de la référence. */
  readonly changed: number;
  /** Changements qui rapprochent le verdict de l'issue (positif → plus sévère, négatif → moins sévère). */
  readonly improved: number;
  /** Changements qui l'en éloignent. */
  readonly degraded: number;
  /** Changements sans issue connue (non jugés). */
  readonly unscored: number;
}

export interface MetricDelta {
  readonly dangerPrecision: number | null;
  readonly dangerRecall: number | null;
  readonly falseSafeRate: number | null;
  readonly cautionPositiveRate: number | null;
}

export interface VariantReplay extends ReplaySide {
  readonly overrides: Readonly<Record<string, number>>;
  readonly changes: VerdictChanges;
  /** Variante − référence (en part, pas en points) ; `null` si un des deux taux est indéfini. */
  readonly delta: MetricDelta;
}

export interface ReplayReport {
  readonly horizon: FollowUpHorizon;
  readonly positive: PositiveClass;
  /** Verdicts rejoués (faits à la version courante). */
  readonly replayed: number;
  /** Verdicts écartés : faits d'une autre version que `RISK_FACTS_VERSION`. */
  readonly skippedFactsVersion: number;
  readonly reference: ReplaySide;
  readonly variants: readonly VariantReplay[];
}

export interface ReplayOptions {
  readonly positive?: PositiveClass;
  readonly minSample?: number;
}

const SEVERITY: Readonly<Record<Verdict, number>> = { safe: 0, warn: 1, danger: 2 };

function emptyVerdictMatrix(): Record<Verdict, Record<Verdict, number>> {
  return {
    safe: { safe: 0, warn: 0, danger: 0 },
    warn: { safe: 0, warn: 0, danger: 0 },
    danger: { safe: 0, warn: 0, danger: 0 },
  };
}

function difference(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a - b;
}

function evaluateAll(records: readonly VerdictRecord[], engine: EvaluateRisk): ScoredVerdict[] {
  return records.map((record) => toScoredVerdict(record.id, engine(record.facts)));
}

/**
 * Rejoue les faits enregistrés avec le moteur de référence et chaque variante, mêmes issues des
 * deux côtés, et compare : métriques, matrice des changements, changements corrigés ou dégradés.
 */
export function replayVariants(
  records: readonly VerdictRecord[],
  outcomes: ReadonlyMap<string, Pick<HorizonOutcome, 'horizon' | 'status'>>,
  variants: readonly EngineVariant[],
  horizon: FollowUpHorizon,
  options: ReplayOptions = {},
): ReplayReport {
  const positive = options.positive ?? 'rug';
  const minSample = options.minSample ?? MIN_SAMPLE_SIZE;
  const resolved = variants.map((variant) => resolveVariant(variant));
  const ids = resolved.map((variant) => variant.id);
  if (new Set(ids).size !== ids.length) throw new RangeError('Identifiant de variante en double.');

  const replayable = records.filter((record) => (record.facts.version as number) === RISK_FACTS_VERSION);
  const accuracyOptions = { horizon, positive, minSample };

  const referenceVariant = resolveReference();
  const referenceVerdicts = evaluateAll(replayable, createRiskEngine(referenceVariant.config));
  const side = (variant: ResolvedVariant, scored: readonly ScoredVerdict[]): ReplaySide => ({
    id: variant.id,
    label: variant.label,
    version: variant.version,
    fingerprint: variant.fingerprint,
    accuracy: computeAccuracy(scored, outcomes, accuracyOptions),
  });
  const reference = side(referenceVariant, referenceVerdicts);

  const replays = resolved.map((variant, index): VariantReplay => {
    const scored = evaluateAll(replayable, createRiskEngine(variant.config));
    const matrix = emptyVerdictMatrix();
    let changed = 0;
    let improved = 0;
    let degraded = 0;
    let unscored = 0;
    scored.forEach((after, position) => {
      const before = referenceVerdicts[position] as ScoredVerdict;
      matrix[before.verdict][after.verdict] += 1;
      if (before.verdict === after.verdict) return;
      changed += 1;
      const outcome = outcomes.get(after.id);
      if (outcome === undefined || outcome.status === 'unknown') {
        unscored += 1;
        return;
      }
      const harsher = SEVERITY[after.verdict] > SEVERITY[before.verdict];
      if (harsher === isPositive(outcome.status, positive)) improved += 1;
      else degraded += 1;
    });
    const own = side(variant, scored);
    const ref = reference.accuracy;
    return {
      ...own,
      overrides: { ...(variants[index] as EngineVariant).overrides },
      changes: { matrix, changed, improved, degraded, unscored },
      delta: {
        dangerPrecision: difference(own.accuracy.dangerPrecision.value, ref.dangerPrecision.value),
        dangerRecall: difference(own.accuracy.dangerRecall.value, ref.dangerRecall.value),
        falseSafeRate: difference(own.accuracy.falseSafeRate.value, ref.falseSafeRate.value),
        cautionPositiveRate: difference(own.accuracy.cautionPositiveRate.value, ref.cautionPositiveRate.value),
      },
    };
  });

  return {
    horizon,
    positive,
    replayed: replayable.length,
    skippedFactsVersion: records.length - replayable.length,
    reference,
    variants: replays,
  };
}
