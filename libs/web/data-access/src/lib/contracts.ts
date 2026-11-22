/**
 * Contrats chargés à la demande. Les schémas Zod pèsent lourd : le code exécuté au démarrage
 * (intercepteurs, store, récupération de la session) ne les importe jamais statiquement, ils
 * arrivent dans un chunk séparé à la première réponse à valider (bundle initial léger).
 */
export type Contracts = typeof import('./contracts-chunk');

let loading: Promise<Contracts> | null = null;

export function loadContracts(): Promise<Contracts> {
  loading ??= import('./contracts-chunk');
  return loading;
}
