/**
 * Contrats chargés à la demande. Les schémas Zod pèsent lourd : le code exécuté au démarrage
 * (intercepteurs, store, récupération de la session) ne les importe jamais statiquement, ils
 * arrivent dans un chunk séparé à la première réponse à valider (bundle initial léger).
 */
export type Contracts = typeof import('./contracts-chunk');

let loading: Promise<Contracts> | null = null;

export function loadContracts(): Promise<Contracts> {
  // Un échec (réseau coupé) n'est pas mémorisé : le prochain appel retente le chargement.
  loading ??= import('./contracts-chunk').catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/**
 * Lance le chargement des contrats sans l'attendre (en parallèle d'une requête dont la réponse
 * sera validée). Un échec est remonté par la validation elle-même, pas ici.
 */
export function prefetchContracts(): void {
  loadContracts().catch(() => undefined);
}
