import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { formatPrice } from '../../../shared/utils/format';
import type { LegView } from '../paper-book';
import { LEG_CLASS, LEG_LABEL } from '../paper-display';

/** Legs of a position: state badge, target and current stop (with the breakeven move made explicit). */
@Component({
  selector: 'app-leg-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <ul class="divide-y divide-line rounded-xl bg-surface-2 text-xs tabular-nums slashed-zero" aria-label="Jambes de la position">
      @for (l of legs(); track l.leg.id) {
        <li class="space-y-1 px-3 py-2" [attr.data-leg]="l.state">
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate font-semibold">{{ l.label }}</span>
            <span class="pill" [class]="legClass[l.state]" data-leg-badge>{{ legLabel[l.state] }}</span>
          </div>
          <div class="flex flex-wrap justify-between gap-x-3 text-muted">
            <span>Objectif <span class="text-bull">{{ price(l.leg.tp_price) }}</span></span>
            @if (l.state === 'open') {
              <span data-leg-stop>
                Stop actuel <span [class.text-bear]="!l.breakevenMoved" [class.text-warn]="l.breakevenMoved">{{ price(l.currentStop) }}</span>
                @if (l.breakevenMoved) {
                  <span class="text-warn" data-breakeven-moved>{{ l.raisedTo === 'x2' ? '(remonté à ×2)' : '(remonté au prix d’achat)' }}</span>
                }
              </span>
            } @else {
              <span>Sortie {{ price(l.leg.exit_price) }}</span>
            }
          </div>
        </li>
      }
    </ul>
  `,
})
export class LegList {
  readonly legs = input.required<readonly LegView[]>();

  protected readonly legLabel = LEG_LABEL;
  protected readonly legClass = LEG_CLASS;
  protected readonly price = formatPrice;
}
