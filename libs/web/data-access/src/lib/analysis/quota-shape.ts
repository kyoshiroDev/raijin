import type { QuotaInfo } from '@raijin/shared-contracts';

/**
 * Validation **sans Zod** de `GET analyses/quota` (copie stricte de `quotaInfoSchema`, équivalence vérifiée par
 * le test) : le quota est lu au premier rendu de `/analyse`, et charger le chunk des contrats pour sept champs
 * coûtait l'évaluation de tout Zod sur le fil principal (TBT, docs/ARCHITECTURE.md §10.6). Champs inconnus
 * retirés, réponse inattendue rejetée (`QuotaShapeError`), comme `quotaInfoSchema.parse`.
 */
export class QuotaShapeError extends Error {
  constructor() {
    super('Quota inattendu');
    this.name = 'QuotaShapeError';
  }
}

/** Copies de `QUOTA_KINDS`, du sujet et de `planSchema` (égalité vérifiée par le test). */
export const SHAPE_QUOTA_KINDS: readonly string[] = ['analysis', 'wallet_scan'];
export const SHAPE_QUOTA_SUBJECTS: readonly string[] = ['anonymous', 'user'];
export const SHAPE_PLANS: readonly string[] = ['FREE', 'PRO'];

/** Date ISO 8601 UTC (`z.iso.datetime()` : secondes obligatoires, fraction facultative, suffixe `Z`). */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

export function readQuotaInfo(body: unknown): QuotaInfo {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new QuotaShapeError();
  const b = body as Record<string, unknown>;
  const { kind, subject, plan, limit, used, remaining, resetsAt } = b;
  if (typeof kind !== 'string' || !SHAPE_QUOTA_KINDS.includes(kind)) throw new QuotaShapeError();
  if (typeof subject !== 'string' || !SHAPE_QUOTA_SUBJECTS.includes(subject)) throw new QuotaShapeError();
  if (plan !== null && (typeof plan !== 'string' || !SHAPE_PLANS.includes(plan))) throw new QuotaShapeError();
  if (limit !== null && !(isInt(limit) && limit > 0)) throw new QuotaShapeError();
  if (!(isInt(used) && used >= 0)) throw new QuotaShapeError();
  if (remaining !== null && !(isInt(remaining) && remaining >= 0)) throw new QuotaShapeError();
  if (typeof resetsAt !== 'string' || !ISO_DATETIME.test(resetsAt) || Number.isNaN(Date.parse(resetsAt))) {
    throw new QuotaShapeError();
  }
  return { kind, subject, plan, limit, used, remaining, resetsAt } as QuotaInfo;
}
