import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Écran « Suivis » : placeholder du socle (phase 1), construit dans une phase ultérieure. */
@Component({
  selector: 'rj-web-feature-suivis',
  template: `
    <section>
      <h1 class="font-display text-h2 text-ink">Suivis</h1>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebFeatureSuivis {}
