import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { RjIcon } from '@raijin/web-ui';

/**
 * Bandeau « Hors ligne » de la coque, chargé par `@defer (on idle)` : rien de ce code dans le bundle initial.
 * Suit `navigator.onLine` et les événements `online` / `offline`. Les écrans gardent leurs propres états
 * d'erreur (Rai alerte + « Réessayer ») ; le bandeau dit seulement pourquoi les données peuvent dater.
 */
@Component({
  selector: 'rj-offline-banner',
  imports: [RjIcon],
  template: `
    @if (offline()) {
      <p class="mb-4 flex items-start gap-3 rounded-lg border border-line-strong bg-surface-raised px-4 py-3 text-body-sm text-ink md:mb-6" data-offline>
        <rj-icon name="wifiOff" [size]="20" class="mt-0.5 shrink-0 text-warn" />
        <span><strong class="font-semibold">Tu es hors ligne.</strong> Les données affichées peuvent dater, et les nouvelles analyses attendront le retour de la connexion.</span>
      </p>
    }
  `,
  host: { role: 'status', class: 'block' },
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
