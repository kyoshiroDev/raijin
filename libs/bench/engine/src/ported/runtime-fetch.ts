// Port Node (bench-engine) : point unique de sortie HTTP du code porté. Sous Deno, les clients appelaient le
// `fetch` global ; sur le VPS, l'API du banc installe au démarrage le `fetch` enveloppé par `@raijin/bench-solana`
// (`withPublicBackoff` : pause dès le 1er 429 des sources à IP partagée avec Raijin, BENCH.md §9 P6).
// Les clients gardent leur `fetchFn` injectable (tests) ; ce n'est que la valeur par défaut qui change.

export type RuntimeFetch = (input: string, init?: RequestInit) => Promise<Response>;

const globalFetch: RuntimeFetch = (input, init) => fetch(input, init);
let current: RuntimeFetch = globalFetch;

/** Installe le `fetch` du processus (appelé une fois par le module Nest de collecte). */
export function setRuntimeFetch(fetchFn: RuntimeFetch | null): void {
  current = fetchFn ?? globalFetch;
}

export function runtimeFetch(): RuntimeFetch {
  return current;
}
