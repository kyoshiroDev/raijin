import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { TrialBannerState } from '@raijin/web-data-access';
import { RjTrialBanner } from '@raijin/web-ui';

/**
 * Bandeau d'essai Pro de la coque (PROMPT.md §4.4), chargé par `@defer` seulement pour un compte en essai
 * (ou à l'essai terminé) : rien de ce code dans le bundle initial. Masqué sur les écrans d'abonnement.
 */
@Component({
  selector: 'rj-trial-banner-host',
  imports: [RjTrialBanner],
  template: `
    @if (banner(); as banner) {
      <rj-trial-banner class="mb-4 md:mb-6" [text]="banner.text" [linkLabel]="banner.linkLabel" [linkPath]="banner.linkPath" (dismiss)="state.dismiss()" />
    }
  `,
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjTrialBannerHost {
  private readonly router = inject(Router);
  protected readonly state = inject(TrialBannerState);
  private readonly url = signal(this.router.url);
  protected readonly banner = computed(() => (this.url().startsWith('/abonnement') ? null : this.state.banner()));

  constructor() {
    this.state.tick();
    const subscription = this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      this.url.set(event.urlAfterRedirects);
      this.state.tick();
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }
}
