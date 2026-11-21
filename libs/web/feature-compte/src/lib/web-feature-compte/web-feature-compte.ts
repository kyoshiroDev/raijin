import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Écran « Compte » : placeholder du socle (phase 1), construit dans une phase ultérieure. */
@Component({
  selector: 'rj-web-feature-compte',
  template: `
    <section>
      <h1 class="font-display text-h2 text-ink">Compte</h1>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebFeatureCompte {}
