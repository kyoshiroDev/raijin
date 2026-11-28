import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RjMascot } from '../mascot/mascot';

/** État vide : Rai (pose bravo), un titre, un message utile et une action facultative projetée. */
@Component({
  selector: 'rj-empty-state',
  imports: [RjMascot],
  template: `
    <rj-mascot pose="bravo" size="md" />
    <div class="flex max-w-sm flex-col gap-2">
      <h2 class="font-display text-h3 text-ink">{{ title() }}</h2>
      @if (description(); as description) {
        <p class="text-body text-ink-muted">{{ description }}</p>
      }
    </div>
    <div class="flex flex-wrap justify-center gap-2 empty:hidden"><ng-content /></div>
  `,
  host: { class: 'flex flex-col items-center gap-4 px-4 py-8 text-center md:py-12' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjEmptyState {
  readonly title = input.required<string>();
  readonly description = input('');
}
