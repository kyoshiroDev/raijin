import type { VerdictRecord } from './contracts';

/** Période couverte par un jeu de verdicts (bornes `verdictAt` incluses), `null` si vide. */
export interface Period {
  readonly from: string;
  readonly to: string;
}

export function periodOf(records: readonly Pick<VerdictRecord, 'verdictAt'>[]): Period | null {
  if (records.length === 0) return null;
  let from = Infinity;
  let to = -Infinity;
  for (const record of records) {
    const time = Date.parse(record.verdictAt);
    from = Math.min(from, time);
    to = Math.max(to, time);
  }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export interface ChronologicalSplit<T> {
  /** Plus anciens : période où l'on règle une variante. */
  readonly calibration: readonly T[];
  /** Plus récents : période où l'on vérifie, sans y retoucher. */
  readonly validation: readonly T[];
  readonly calibrationPeriod: Period | null;
  readonly validationPeriod: Period | null;
}

/**
 * Découpage chronologique (jamais aléatoire : pas de fuite du futur vers le passé). Les verdicts sont
 * triés par `verdictAt` puis par identifiant ; la part `calibrationRatio` la plus ancienne sert au
 * réglage, le reste à la validation.
 */
export function splitChronologically<T extends Pick<VerdictRecord, 'id' | 'verdictAt'>>(
  records: readonly T[],
  calibrationRatio = 0.7,
): ChronologicalSplit<T> {
  if (!Number.isFinite(calibrationRatio) || calibrationRatio <= 0 || calibrationRatio >= 1) {
    throw new RangeError('Part de calibration hors de ]0, 1[.');
  }
  const sorted = [...records].sort(
    (a, b) => Date.parse(a.verdictAt) - Date.parse(b.verdictAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const cut = Math.floor(sorted.length * calibrationRatio);
  const calibration = sorted.slice(0, cut);
  const validation = sorted.slice(cut);
  return { calibration, validation, calibrationPeriod: periodOf(calibration), validationPeriod: periodOf(validation) };
}
