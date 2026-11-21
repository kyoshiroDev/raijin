import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Écran « Alertes » : placeholder du socle (phase 1). Les alertes vivent avec les suivis (docs/ARCHITECTURE.md). */
@Component({
  selector: 'rj-web-feature-alertes',
  template: `
    <section>
      <h1 class="font-display text-h2 text-ink">Alertes</h1>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebFeatureAlertes {}
