import * as z from 'zod';
import { UpstreamError, type UpstreamId } from '../core/errors';
import { requestJson } from '../core/http';
import type { FetchLike, SolanaLogger } from '../core/ports';
import type { UpstreamGate } from '../core/upstream-gate';

const rpcErrorSchema = z.object({ code: z.number() });

export interface JsonRpcTransport {
  readonly source: UpstreamId;
  /** Construit l'URL au moment de l'appel (la clé Helius n'est stockée qu'ici, jamais exposée). */
  readonly url: () => string;
  readonly gate: UpstreamGate;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly logger: SolanaLogger;
}

/**
 * Appel JSON-RPC 2.0 validé par un schéma Zod. Les erreurs RPC sont réduites à un type
 * (`rate_limited` pour -32429 / 429, `rpc_error` sinon) : le message du fournisseur n'est pas repris.
 */
export async function callJsonRpc<T>(
  transport: JsonRpcTransport,
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  return transport.gate.run(async () => {
    const startedAt = Date.now();
    let status: number | string = 'error';
    try {
      const response = await requestJson(transport.fetch, {
        source: transport.source,
        url: transport.url(),
        method: 'POST',
        body: { jsonrpc: '2.0', id: 1, method, params },
        timeoutMs: transport.timeoutMs,
        maxBytes: transport.maxBytes,
        signal,
      });
      status = response.status;
      if (response.status !== 200) throw new UpstreamError(transport.source, 'http_error', response.status);
      const body = response.body;
      if (typeof body !== 'object' || body === null) {
        throw new UpstreamError(transport.source, 'invalid_response', response.status);
      }
      if ('error' in body && body.error !== undefined && body.error !== null) {
        const parsedError = rpcErrorSchema.safeParse(body.error);
        const code = parsedError.success ? parsedError.data.code : null;
        throw new UpstreamError(transport.source, code === 429 || code === -32429 ? 'rate_limited' : 'rpc_error', code);
      }
      if (!('result' in body)) throw new UpstreamError(transport.source, 'invalid_response', response.status);
      const result = schema.safeParse(body.result);
      if (!result.success) throw new UpstreamError(transport.source, 'invalid_response', response.status);
      return result.data;
    } catch (error) {
      if (error instanceof UpstreamError) status = error.kind;
      throw error;
    } finally {
      transport.logger.debug('upstream_call', { source: transport.source, method, status, latencyMs: Date.now() - startedAt });
    }
  }, signal);
}
