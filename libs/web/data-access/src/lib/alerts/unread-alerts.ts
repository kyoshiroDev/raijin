import { HttpClient } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, Injector, effect, inject, signal, untracked } from '@angular/core';
import { AuthStore } from '../auth/auth.store';
import { API_BASE_URL } from '../config/api-config';
import { runAfterFirstRoute } from '../util/idle';

/** Rafraîchissement du badge tant que l'onglet est visible. */
export const UNREAD_REFRESH_MS = 120_000;

/** Lecture sans Zod (service chargé au démarrage) : `{ unread: entier ≥ 0 }`, sinon `null`. */
export function readUnreadCount(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const unread = (body as { unread?: unknown }).unread;
  return typeof unread === 'number' && Number.isInteger(unread) && unread >= 0 ? unread : null;
}

/**
 * Nombre d'alertes non lues (badge de la barre d'onglets, de la barre latérale et du header).
 * Rien au démarrage : la première lecture part après le premier rendu de la route, une fois la
 * session connue, puis toutes les 2 minutes tant que l'onglet est visible. Les écrans d'alertes
 * le mettent à jour directement (`set`) avec le total renvoyé par l'API.
 */
@Injectable({ providedIn: 'root' })
export class UnreadAlerts {
  private readonly injector = inject(Injector);
  private readonly current = signal(0);
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private request: Promise<void> | null = null;

  readonly count = this.current.asReadonly();

  set(count: number): void {
    this.current.set(Math.max(0, Math.trunc(count)));
  }

  /** À appeler dans un contexte d'injection (coquille de l'app). */
  startAfterFirstRoute(): void {
    if (this.started) return;
    this.started = true;
    runAfterFirstRoute(() => this.watchSession());
  }

  /** Relit le compteur (silencieux : un échec garde la dernière valeur connue). */
  refresh(): Promise<void> {
    const auth = this.injector.get(AuthStore);
    if (!auth.isAuthenticated()) {
      this.current.set(0);
      return Promise.resolve();
    }
    this.request ??= new Promise<void>((resolve) => {
      const http = this.injector.get(HttpClient);
      http.get(`${this.injector.get(API_BASE_URL)}/alerts/unread-count`).subscribe({
        next: (body) => {
          const unread = readUnreadCount(body);
          if (unread !== null) this.current.set(unread);
        },
        error: () => resolve(),
        complete: () => resolve(),
      });
    }).finally(() => (this.request = null));
    return this.request;
  }

  private watchSession(): void {
    const auth = this.injector.get(AuthStore);
    const view = this.injector.get(DOCUMENT).defaultView;
    effect(
      () => {
        const authenticated = auth.isAuthenticated();
        untracked(() => {
          if (authenticated) {
            void this.refresh();
            this.startTimer(view);
          } else {
            this.stopTimer();
            this.current.set(0);
          }
        });
      },
      { injector: this.injector },
    );
    const onVisible = () => {
      if (view?.document.visibilityState === 'visible') void this.refresh();
    };
    view?.document.addEventListener('visibilitychange', onVisible);
    this.injector.get(DestroyRef).onDestroy(() => {
      this.stopTimer();
      view?.document.removeEventListener('visibilitychange', onVisible);
    });
  }

  private startTimer(view: Window | null): void {
    if (this.timer || !view) return;
    this.timer = setInterval(() => {
      if (view.document.visibilityState !== 'hidden') void this.refresh();
    }, UNREAD_REFRESH_MS);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
