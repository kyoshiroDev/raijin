import type { AnalysisResponse, AnalysisResult, QuotaInfo } from '@raijin/shared-contracts';

/**
 * Contrôle de **forme** (sans Zod) d'une réponse d'analyse, juste assez pour l'afficher sans
 * planter : le verdict est rendu avant la validation complète par les contrats, faite ensuite à
 * l'inactivité du navigateur (`AnalysisStore`, docs/ARCHITECTURE.md §10). Les données viennent de
 * notre API, qui les nettoie déjà ; l'écran les rend toujours comme du texte et filtre les liens
 * (`isAllowedHttpsUrl`). Si la validation complète échoue, l'écran repasse en état d'erreur.
 */
export class AnalysisShapeError extends Error {
  constructor() {
    super('Réponse d’analyse inattendue');
    this.name = 'AnalysisShapeError';
  }
}

const VERDICTS: readonly unknown[] = ['safe', 'warn', 'danger'];
const STATUSES: readonly unknown[] = ['ok', 'warn', 'danger', 'unavailable'];

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown) => value === null || value === undefined || isString(value);
const isNullableNumber = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value));

function isMetric(value: unknown): boolean {
  if (!isObject(value) || !isString(value['key']) || !isString(value['label']) || !isNullableString(value['unit'])) return false;
  const metric = value['value'];
  return metric === null || typeof metric === 'boolean' || isString(metric) || (typeof metric === 'number' && Number.isFinite(metric));
}

function isCheck(value: unknown): boolean {
  return (
    isObject(value) &&
    isString(value['id']) &&
    STATUSES.includes(value['status']) &&
    isString(value['summary']) &&
    Array.isArray(value['metrics']) &&
    value['metrics'].every(isMetric) &&
    Array.isArray(value['sources']) &&
    value['sources'].every(isObject)
  );
}

/** Résultat affichable, ou `AnalysisShapeError`. */
export function readAnalysisResult(body: unknown): AnalysisResult {
  if (
    !isObject(body) ||
    !isString(body['mint']) ||
    !isObject(body['token']) ||
    !isNullableString(body['token']['name']) ||
    !isNullableString(body['token']['symbol']) ||
    !VERDICTS.includes(body['verdict']) ||
    !isString(body['explanation']) ||
    !isString(body['analyzedAt']) ||
    Number.isNaN(Date.parse(body['analyzedAt'])) ||
    !Array.isArray(body['checks']) ||
    !body['checks'].every(isCheck)
  ) {
    throw new AnalysisShapeError();
  }
  return body as unknown as AnalysisResult;
}

function readQuota(body: unknown): QuotaInfo {
  if (!isObject(body) || !isNullableNumber(body['limit']) || !isNullableNumber(body['remaining']) || typeof body['used'] !== 'number') {
    throw new AnalysisShapeError();
  }
  return body as unknown as QuotaInfo;
}

/** Réponse de `POST analyses` affichable (résultat + quota), ou `AnalysisShapeError`. */
export function readAnalysisResponse(body: unknown): AnalysisResponse {
  if (!isObject(body)) throw new AnalysisShapeError();
  return { analysis: readAnalysisResult(body['analysis']), quota: readQuota(body['quota']) };
}
