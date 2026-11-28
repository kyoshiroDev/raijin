import { DestroyRef, inject, signal } from '@angular/core';
import { toClientError, type ClientError } from '../http/api-error';
import { AdminSessionStore } from './security/admin-session.store';

export type AdminReportStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * État d'un écran admin (signals) : données, chargement, erreur. Les données restent affichées pendant un
 * rechargement (changement de période) ; seule la dernière requête lancée est prise en compte. Effacé dès que la
 * session admin se verrouille (expiration, déconnexion) : rien ne reste à l'écran ni en mémoire.
 * Aucune donnée admin n'est écrite dans `localStorage` ou `sessionStorage`.
 */
export class AdminReport<T> {
  private readonly current = signal<T | null>(null);
  private readonly currentStatus = signal<AdminReportStatus>('idle');
  private readonly currentError = signal<ClientError | null>(null);
  private request = 0;

  readonly data = this.current.asReadonly();
  readonly status = this.currentStatus.asReadonly();
  readonly error = this.currentError.asReadonly();

  async load(fetch: () => Promise<T>): Promise<void> {
    const id = ++this.request;
    this.currentStatus.set('loading');
    try {
      const data = await fetch();
      if (id !== this.request) return;
      this.current.set(data);
      this.currentError.set(null);
      this.currentStatus.set('ready');
    } catch (error) {
      if (id !== this.request) return;
      this.currentError.set(toClientError(error));
      this.currentStatus.set('error');
    }
  }

  /** Remplace les données (après une action, sans relecture). */
  set(data: T): void {
    this.current.set(data);
    this.currentStatus.set('ready');
  }

  reset(): void {
    this.request += 1;
    this.current.set(null);
    this.currentError.set(null);
    this.currentStatus.set('idle');
  }
}

/** Crée l'état d'un écran, vidé au verrouillage de la session admin (à appeler dans un contexte d'injection). */
export function createAdminReport<T>(): AdminReport<T> {
  const report = new AdminReport<T>();
  const session = inject(AdminSessionStore, { optional: true });
  const unsubscribe = session?.onReset(() => report.reset());
  if (unsubscribe) inject(DestroyRef).onDestroy(() => unsubscribe());
  return report;
}
