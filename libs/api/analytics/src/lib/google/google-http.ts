import type { GoogleServiceError } from '@raijin/shared-contracts';

/** `fetch` injectable (tests) : même signature que le `fetch` global de Node. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Délai d'un appel Google (ms) et nombre de reprises après une panne passagère. */
export const GOOGLE_TIMEOUT_MS = 10_000;
export const GOOGLE_RETRIES = 1;

/**
 * Erreur Google traduite en code interne. Jamais le corps de la réponse (il peut citer l'identifiant de la propriété,
 * l'e-mail du compte de service ou un jeton) : seulement le statut HTTP et le code.
 */
export class GoogleApiError extends Error {
  constructor(
    readonly code: GoogleServiceError,
    readonly status: number | null,
  ) {
    super(`Google ${code}${status === null ? '' : ` (HTTP ${status})`}`);
    this.name = 'GoogleApiError';
  }
}

/** Statut HTTP → code interne (`auth_failed | permission_denied | quota_exceeded | unavailable`). */
export function errorFromStatus(status: number): GoogleServiceError {
  if (status === 401) return 'auth_failed';
  if (status === 403 || status === 404) return 'permission_denied';
  if (status === 429) return 'quota_exceeded';
  return 'unavailable';
}

/**
 * POST JSON vers un hôte Google **fixe** (aucune URL venue de l'extérieur), délai 10 s, une reprise sur 5xx, délai
 * dépassé ou panne réseau. Renvoie le JSON de la réponse (non fiable : validé par l'appelant).
 */
export async function postJson(fetchFn: FetchFn, url: string, body: unknown, headers: Record<string, string>, retries = GOOGLE_RETRIES): Promise<unknown> {
  let lastError: GoogleApiError = new GoogleApiError('unavailable', null);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      lastError = new GoogleApiError('unavailable', null);
      continue;
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new GoogleApiError('unavailable', response.status);
      }
    }
    // Corps ignoré (jamais lu ni journalisé).
    await response.body?.cancel().catch(() => undefined);
    lastError = new GoogleApiError(errorFromStatus(response.status), response.status);
    if (lastError.code !== 'unavailable') throw lastError;
  }
  throw lastError;
}
