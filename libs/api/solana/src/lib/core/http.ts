import { UpstreamError, type UpstreamId } from './errors';
import type { FetchLike } from './ports';

export interface JsonRequest {
  readonly source: UpstreamId;
  /** URL complète (peut contenir la clé Helius : jamais journalisée ni renvoyée). */
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Échéance globale de la collecte (annule l'appel). */
  readonly signal?: AbortSignal;
}

export interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

async function readLimited(response: Response, source: UpstreamId, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError(source, 'too_large', response.status);
  }
  /* istanbul ignore next -- toutes les réponses fetch ont un corps (sauf 204/HEAD, non utilisés). */
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamError(source, 'too_large', response.status);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Appel JSON durci (ARCHITECTURE.md §9.3, §9.8) : `redirect: 'error'`, délai par appel, taille
 * bornée, `content-type` JSON exigé, erreurs réemballées **sans `cause`** (l'URL peut contenir la clé).
 * 429 → `rate_limited` (avec `Retry-After`), 5xx → `http_error` ; les autres statuts sont renvoyés
 * avec leur corps JSON pour que le client les interprète (ex. Jupiter 400 « aucune route »).
 */
export async function requestJson(fetchFn: FetchLike, request: JsonRequest): Promise<JsonResponse> {
  const { source } = request;
  if (request.signal?.aborted) throw new UpstreamError(source, 'aborted');

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  const onAbort = () => controller.abort();
  request.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetchFn(request.url, {
        method: request.method ?? 'GET',
        headers:
          request.body === undefined
            ? { accept: 'application/json' }
            : { accept: 'application/json', 'content-type': 'application/json' },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      // Erreur volontairement ignorée : elle peut contenir l'URL (et la clé).
      if (timedOut) throw new UpstreamError(source, 'timeout');
      if (request.signal?.aborted) throw new UpstreamError(source, 'aborted');
      throw new UpstreamError(source, 'network');
    }

    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpstreamError(source, 'rate_limited', 429, parseRetryAfter(response.headers.get('retry-after')));
    }
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpstreamError(source, 'http_error', response.status);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpstreamError(source, 'invalid_response', response.status);
    }

    let text: string;
    try {
      text = await readLimited(response, source, request.maxBytes);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (timedOut) throw new UpstreamError(source, 'timeout');
      throw new UpstreamError(source, request.signal?.aborted ? 'aborted' : 'network');
    }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      throw new UpstreamError(source, 'invalid_response', response.status);
    }
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
  }
}
