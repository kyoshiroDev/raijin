import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Écran « Scan de wallet » : placeholder du socle (phase 1), construit dans une phase ultérieure. */
@Component({
  selector: 'rj-web-feature-wallet',
  template: `
    <section class="mx-auto max-w-reading px-4 py-6 md:px-6 lg:px-8">
      <h1 class="font-display text-h2 text-ink">Scan de wallet</h1>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebFeatureWallet {}
