import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Écran « Compte » : placeholder du socle (phase 1), construit dans une phase ultérieure. */
@Component({
  selector: 'rj-web-feature-compte',
  template: `
    <section class="mx-auto max-w-reading px-4 py-6 md:px-6 lg:px-8">
      <h1 class="font-display text-h2 text-ink">Compte</h1>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebFeatureCompte {}
