import type { BenchJobDetails } from '../jobs/job-registry';
import type { BenchConfig } from './bench-config';

/**
 * Variables des anciennes Edge Functions → variables `BENCH_*` du banc (docs/BENCH.md §6, docs/ENV.md « Banc ») :
 * le code porté garde ses noms (`env('JUP_API_KEY')`…), l'API ne lit que les `BENCH_*` (jamais `JUP_API_KEY` de Raijin).
 */
export const LEGACY_ENV_NAMES: Readonly<Record<string, string>> = {
  JUP_API_BASE: 'BENCH_JUP_API_BASE',
  JUP_API_KEY: 'BENCH_JUP_API_KEY',
  MIN_MARKET_CAP: 'BENCH_MIN_MARKET_CAP',
  MIN_LIQUIDITY: 'BENCH_MIN_LIQUIDITY',
  SCAN_KEYWORDS: 'BENCH_SCAN_KEYWORDS',
};

export function legacyEnv(config: Pick<BenchConfig, 'solanaEnv'>): (name: string) => string | undefined {
  return (name) => {
    const bench = LEGACY_ENV_NAMES[name];
    if (bench === undefined) return undefined;
    const value = config.solanaEnv[bench]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
}

/** Compteurs d'un job pour `job_runs.details` : valeurs simples du premier niveau, puis d'un niveau imbriqué (`a.b`). */
export function flatDetails(stats: unknown, max = 40): BenchJobDetails {
  const out: Record<string, string | number | boolean | null> = {};
  const put = (key: string, value: unknown): void => {
    if (Object.keys(out).length >= max) return;
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, 120);
  };
  if (stats && typeof stats === 'object') {
    for (const [key, value] of Object.entries(stats as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [sub, v] of Object.entries(value as Record<string, unknown>)) put(`${key}.${sub}`, v);
      } else put(key, value);
    }
  }
  return out;
}
