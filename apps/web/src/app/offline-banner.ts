import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';

/**
 * Bandeau « Hors ligne » de la coque, chargé par `@defer (on idle)` : rien de ce code dans le bundle initial.
 * Suit `navigator.onLine` et les événements `online` / `offline`. Les écrans gardent leurs propres états
 * d'erreur (Rai alerte + « Réessayer ») ; le bandeau dit seulement pourquoi les données peuvent dater.
 */
@Component({
  selector: 'rj-offline-banner',
  template: `
    @if (offline()) {
      <p class="mt-4 flex items-start gap-3 rounded-lg border border-line-strong bg-surface-raised px-4 py-3 text-body-sm text-ink md:mt-6 lg:mt-8" data-offline>
        <!-- Icône « wifi coupé » (Lucide) en ligne : le chunk d'icônes peut manquer une fois hors ligne. -->
        <svg class="mt-0.5 size-5 shrink-0 text-warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M12 20h.01" /><path d="M8.5 16.429a5 5 0 0 1 7 0" /><path d="M5 12.859a10 10 0 0 1 5.17-2.69" /><path d="M19 12.859a10 10 0 0 0-2.007-1.523" />
          <path d="M2 8.82a15 15 0 0 1 4.177-2.643" /><path d="M22 8.82a15 15 0 0 0-11.288-3.764" /><path d="m2 2 20 20" />
        </svg>
        <span><strong class="font-semibold">Tu es hors ligne.</strong> Les données affichées peuvent dater, et les nouvelles analyses attendront le retour de la connexion.</span>
      </p>
    }
  `,
  // Région live sans rôle `status` : annonce l'arrivée hors ligne sans ajouter un « status » permanent à la page.
  host: { 'aria-live': 'polite', class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjOfflineBanner {
  protected readonly offline = signal(false);

  constructor() {
    const view = inject(DOCUMENT).defaultView;
    if (!view) return;
    this.offline.set(view.navigator.onLine === false);
    const update = (): void => this.offline.set(view.navigator.onLine === false);
    view.addEventListener('online', update);
    view.addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      view.removeEventListener('online', update);
      view.removeEventListener('offline', update);
    });
  }
}
