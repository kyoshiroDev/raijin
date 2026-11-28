import type { UpstreamId } from '../core/errors';
import { requestJson, type JsonResponse } from '../core/http';
import type { FetchLike, SolanaLogger } from '../core/ports';
import type { UpstreamGate } from '../core/upstream-gate';

export interface RestTransport {
  readonly source: UpstreamId;
  readonly baseUrl: string;
  readonly gate: UpstreamGate;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly logger: SolanaLogger;
}

/** Segment de chemin : seule donnée variable insérée dans l'URL (mint base58 déjà validé). */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * GET JSON sous la file de débit de la source. `path` commence par `/` et n'est construit qu'à
 * partir de gabarits fixes + `pathSegment(...)` ; seuls la source, le gabarit de chemin (`route`),
 * le statut et la latence sont journalisés. `parse` (validation Zod du client) est exécuté **dans**
 * la tentative : une réponse hors schéma est comptée comme un échec `validation` de la source.
 */
export function getJson<T = JsonResponse>(
  transport: RestTransport,
  route: string,
  path: string,
  signal?: AbortSignal,
  parse: (response: JsonResponse) => T = (response) => response as T,
  maxBytes = transport.maxBytes,
): Promise<T> {
  return transport.gate.run(async () => {
    const startedAt = Date.now();
    let status: number | string = 'error';
    try {
      const response = await requestJson(transport.fetch, {
        source: transport.source,
        url: `${transport.baseUrl}${path}`,
        timeoutMs: transport.timeoutMs,
        maxBytes,
        signal,
      });
      status = response.status;
      return parse(response);
    } catch (error) {
      status = (error as { kind?: string }).kind ?? 'error';
      throw error;
    } finally {
      transport.logger.debug('upstream_call', { source: transport.source, method: route, status, latencyMs: Date.now() - startedAt });
    }
  }, signal);
}
