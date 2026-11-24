/**
 * Ressources liées lues par le code porté (`select('…, paper_legs(…)')`), déduites par PostgREST des clés
 * étrangères de Supabase ; ici déclarées une fois (mêmes clés étrangères dans `raijin_bench`, T5).
 * - `many` : tableau (une position → ses jambes) ;
 * - `one` : objet ou `null` (une détection → son token).
 */
export interface Relationship {
  readonly cardinality: 'many' | 'one';
  /** Colonne de la table lue. */
  readonly localColumn: string;
  /** Colonne de la table liée. */
  readonly foreignColumn: string;
}

export const BENCH_RELATIONSHIPS: Readonly<Record<string, Readonly<Record<string, Relationship>>>> = {
  paper_positions: { paper_legs: { cardinality: 'many', localColumn: 'id', foreignColumn: 'position_id' } },
  signal_outcomes: { tokens: { cardinality: 'one', localColumn: 'mint', foreignColumn: 'mint' } },
  preset_signals: { tokens: { cardinality: 'one', localColumn: 'mint', foreignColumn: 'mint' } },
};

export function relationship(table: string, embedded: string): Relationship {
  const rel = BENCH_RELATIONSHIPS[table]?.[embedded];
  if (!rel) throw Object.assign(new Error(`aucune relation ${table} → ${embedded}`), { code: 'PGRST200' });
  return rel;
}
