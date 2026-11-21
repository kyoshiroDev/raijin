import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Écran « Analyser » : placeholder du socle (phase 1), construit dans une phase ultérieure. */
@Component({
  selector: 'rj-web-feature-analyse',
  template: `
    <section>
      <h1 class="font-display text-h2 text-ink">Analyser</h1>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebFeatureAnalyse {}
