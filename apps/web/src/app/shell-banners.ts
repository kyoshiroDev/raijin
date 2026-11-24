import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AuthStore } from '@raijin/web-data-access';
import { RjOfflineBanner } from './offline-banner';
import { RjTrialBannerHost } from './trial-banner-host';

/**
 * Bandeaux de la coque (hors ligne, essai Pro), chargés ensemble par un seul `@defer (on idle)` de `App` :
 * aucun de ces codes dans le bundle initial, ni le calcul de l'essai. Le bandeau d'essai reste dans son
 * propre chunk, chargé seulement pour un compte en essai (ou à l'essai terminé).
 */
@Component({
  selector: 'rj-shell-banners',
  imports: [RjOfflineBanner, RjTrialBannerHost],
  template: `
    <rj-offline-banner />
    @defer (when trialAccount()) {
      <rj-trial-banner-host />
    }
  `,
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjShellBanners {
  private readonly auth = inject(AuthStore);
  /** Essai en cours, ou terminé sans abonnement (écran de fin peut-être à voir) : déclenche le `@defer`. */
  protected readonly trialAccount = computed(() => {
    const trial = this.auth.user()?.trial.status;
    return trial === 'active' || (trial === 'ended' && this.auth.user()?.plan === 'FREE');
  });
}
