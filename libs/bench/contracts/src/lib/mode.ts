import * as z from './zod';

/**
 * Mode de l'API du banc (`BENCH_MODE`, docs/ARCHITECTURE.md §17.6) :
 * - `shadow` : collecte et jobs actifs, aucune notification (push, e-mail), aucune ouverture
 *   automatique de position paper ; comparaison avec l'instantané `shadow_ref` de Supabase ;
 * - `primary` : le banc du VPS est la référence (après bascule, docs/BENCH.md).
 */
export const BENCH_MODES = ['shadow', 'primary'] as const;
export const benchModeSchema = z.enum(BENCH_MODES);
export type BenchMode = z.infer<typeof benchModeSchema>;
