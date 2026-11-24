import { Injectable } from '@angular/core';

/** Ce dont l'intercepteur a besoin de `AdminSessionStore` (prolonger la session, verrouiller sur un 403). */
export interface AdminSessionHandle {
  touch(): void;
  handleError(error: unknown): void;
}

/**
 * Lien léger entre l'intercepteur HTTP (bundle initial) et `AdminSessionStore` (chunk admin) : le store s'y
 * inscrit à sa création. L'intercepteur ne référence jamais le store statiquement, qui reste hors du bundle
 * initial (docs/ARCHITECTURE.md §10.6, G1).
 */
@Injectable({ providedIn: 'root' })
export class AdminSessionLink {
  current: AdminSessionHandle | null = null;
}
