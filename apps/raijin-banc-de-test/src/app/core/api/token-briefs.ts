import { BENCH_ROUTES, MINTS_PER_QUERY_MAX } from '@raijin/bench-contracts';
import { itemsOf, type BenchApi } from './bench-api';

/**
 * `GET /api/tokens/briefs?mints=` (symbole et dernier prix connu : `tokens`, sinon dernier snapshot), par lots de
 * 100 mints au plus. Renvoie les lignes brutes, à valider par l'appelant. Un lot en échec rejette la promesse.
 */
export async function fetchTokenBriefs(api: Pick<BenchApi, 'get'>, mints: readonly string[]): Promise<unknown[]> {
  const unique = [...new Set(mints)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += MINTS_PER_QUERY_MAX) batches.push(unique.slice(i, i + MINTS_PER_QUERY_MAX));
  const pages = await Promise.all(batches.map((batch) => api.get(BENCH_ROUTES.tokenBriefs, { query: { mints: batch } })));
  return pages.flatMap(itemsOf);
}
