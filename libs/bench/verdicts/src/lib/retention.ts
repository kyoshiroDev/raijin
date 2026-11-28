import {
  DEFAULT_RETENTION_POLICY,
  STORAGE_ALERT_RATIOS,
  STORAGE_LEVELS,
  retentionPolicySchema,
  type RetentionPolicy,
  type StorageLevel,
} from './contracts';

/**
 * Rétention et alerte de taille de la base du banc (docs/ARCHITECTURE.md §16.5). Fonctions pures :
 * `now` est toujours fourni par l'appelant (job de purge en phase 8 bis). Les agrégats quotidiens
 * ne sont jamais purgés et sont calculés avant la purge.
 */

const DAY_MS = 86_400_000;

/** Lignes strictement antérieures à ces instants (ISO 8601) : à purger. */
export interface PurgeCutoffs {
  readonly detailedSnapshotsBefore: string;
  readonly verdictRecordsBefore: string;
  readonly jobRunsBefore: string;
}

export function purgeCutoffs(now: Date, policy: RetentionPolicy = DEFAULT_RETENTION_POLICY): PurgeCutoffs {
  const at = now.getTime();
  if (!Number.isFinite(at)) throw new RangeError('Date de référence invalide.');
  const valid = retentionPolicySchema.parse(policy);
  const before = (days: number) => new Date(at - days * DAY_MS).toISOString();
  return {
    detailedSnapshotsBefore: before(valid.detailedSnapshotsDays),
    verdictRecordsBefore: before(valid.verdictRecordsDays),
    jobRunsBefore: before(valid.jobRunsDays),
  };
}

export interface StorageAssessment {
  /** Part de l'espace alloué utilisée (peut dépasser 1). */
  readonly ratio: number;
  readonly level: StorageLevel;
}

/** Niveau d'occupation : ≥ 0,8 → `warn`, ≥ 0,95 → `critical`. Allocation nulle ou négative refusée. */
export function assessStorage(usedBytes: number, allocatedBytes: number): StorageAssessment {
  if (!Number.isFinite(allocatedBytes) || allocatedBytes <= 0) throw new RangeError('Espace alloué invalide.');
  if (!Number.isFinite(usedBytes) || usedBytes < 0) throw new RangeError('Espace utilisé invalide.');
  const ratio = usedBytes / allocatedBytes;
  const level: StorageLevel =
    ratio >= STORAGE_ALERT_RATIOS.critical ? 'critical' : ratio >= STORAGE_ALERT_RATIOS.warn ? 'warn' : 'ok';
  return { ratio, level };
}

/** Notifier seulement quand le niveau monte (`ok` → `warn`, `warn` → `critical`…), jamais en répétition. */
export function shouldNotifyStorage(previous: StorageLevel | null, current: StorageLevel): boolean {
  return STORAGE_LEVELS.indexOf(current) > STORAGE_LEVELS.indexOf(previous ?? 'ok');
}
