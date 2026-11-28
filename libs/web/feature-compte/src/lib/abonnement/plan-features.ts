import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RjIcon } from '@raijin/web-ui';
import type { EntitlementLine } from './billing-texts';

/** Liste des droits d'un plan : icône + texte (jamais la couleur seule), inclus ou non. */
@Component({
  selector: 'rj-plan-features',
  imports: [RjIcon],
  template: `
    <ul class="flex flex-col gap-2.5">
      @for (line of lines(); track line.text) {
        <li class="flex items-start gap-2.5 text-body" [class]="line.included ? 'text-ink' : 'text-ink-muted'">
          @if (line.included) {
            <rj-icon name="check" [size]="16" class="mt-1 shrink-0 text-thunder-ink" />
            <span class="sr-only">Inclus :</span>
          } @else {
            <rj-icon name="close" [size]="16" class="mt-1 shrink-0 text-ink-muted" />
            <span class="sr-only">Non inclus :</span>
          }
          <span>{{ line.text }}</span>
        </li>
      }
    </ul>
  `,
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjPlanFeatures {
  readonly lines = input.required<readonly EntitlementLine[]>();
}
