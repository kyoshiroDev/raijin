import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { isNotFound, type BenchApi } from '../../core/api/bench-api';
import { parseTokenRow, type TokenRow, isSolanaAddress } from '@raijin/bench-web-logic';

/** Loads one token by mint (`GET /api/tokens/:mint`, 404 → null). Never queries with an invalid mint. */
export async function fetchTokenByMint(api: Pick<BenchApi, 'get'>, mint: string, signal?: AbortSignal): Promise<TokenRow | null> {
  if (!isSolanaAddress(mint)) return null;
  try {
    return parseTokenRow(await api.get(BENCH_ROUTES.token, { params: { mint }, signal }));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new Error('token query failed');
  }
}
