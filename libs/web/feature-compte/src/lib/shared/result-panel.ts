import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RjMascot } from '@raijin/web-ui';

/**
 * Écran de résultat d'un lien reçu par e-mail : Rai bravo (succès) ou Rai alerte (échec),
 * le titre de l'écran (h1), un message et les actions projetées. Une seule mascotte par écran.
 */
@Component({
  selector: 'rj-result-panel',
  imports: [RjMascot],
  template: `
    <rj-mascot [pose]="pose()" size="md" />
    <div class="flex max-w-sm flex-col gap-2">
      <h1 class="font-display text-h2 text-ink">{{ title() }}</h1>
      @if (description(); as description) {
        <p class="text-body text-ink-muted">{{ description }}</p>
      }
    </div>
    <div class="flex w-full flex-col gap-3 empty:hidden"><ng-content /></div>
  `,
  host: {
    class: 'flex flex-col items-center gap-5 text-center',
    '[attr.role]': "pose() === 'alerte' ? 'alert' : 'status'",
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjResultPanel {
  readonly pose = input.required<'bravo' | 'alerte'>();
  readonly title = input.required<string>();
  readonly description = input('');
}
