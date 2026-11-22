import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RjMascot } from '../mascot/mascot';

/**
 * Page d'état (404, maintenance) : Rai pose bravo, un repère discret (« Erreur 404 »), un titre,
 * une phrase et les actions projetées (lien de retour). Présentation pure, centrée verticalement
 * dans la zone de contenu, de 320 px à 1440 px.
 */
@Component({
  selector: 'rj-status-page',
  imports: [RjMascot],
  template: `
    <rj-mascot pose="bravo" size="lg" />
    <div class="flex max-w-xl flex-col gap-2">
      @if (eyebrow(); as eyebrow) {
        <p class="text-label font-medium tracking-wide text-ink-muted uppercase">{{ eyebrow }}</p>
      }
      <h1 class="font-display text-h2 text-balance text-ink md:text-h1">{{ title() }}</h1>
      <p class="mx-auto max-w-md text-body text-pretty text-ink-muted">{{ description() }}</p>
    </div>
    <div class="flex w-full max-w-xs flex-col items-stretch gap-2 empty:hidden sm:w-auto sm:max-w-none sm:flex-row sm:justify-center">
      <ng-content />
    </div>
  `,
  host: { class: 'flex min-h-[60dvh] flex-col items-center justify-center gap-6 px-4 py-8 text-center md:py-12' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjStatusPage {
  readonly eyebrow = input('');
  readonly title = input.required<string>();
  readonly description = input.required<string>();
}
