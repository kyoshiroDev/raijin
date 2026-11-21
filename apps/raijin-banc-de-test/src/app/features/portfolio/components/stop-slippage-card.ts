import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BOOK_LABEL } from '../../../shared/models/paper';
import { formatCount, formatSignedPercentFr } from '../../../shared/utils/format';
import type { StopSlippage } from '../stop-slippage';

/**
 * « Glissement à la sortie sur stop »: per book, how many stopped legs, mean and worst gap between the planned stop
 * and the price really executed. « Aucun stop touché » when n = 0.
 */
@Component({
  selector: 'app-stop-slippage-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-3 p-3', 'data-stop-slippage': '' },
  template: `
    <p class="text-xs text-muted">Écart entre le stop prévu et le prix réellement exécuté (glissement simulé inclus). Négatif = vendu sous le stop.</p>
    @for (s of rows(); track s.book) {
      <div class="space-y-1" [attr.data-book]="s.book">
        @if (showBook()) { <h3 class="text-sm font-bold">{{ label[s.book] }}</h3> }
        @if (s.n === 0) {
          <p class="text-sm text-muted" data-no-stop>Aucun stop touché.</p>
        } @else {
          <dl class="grid grid-cols-3 gap-x-3 text-xs tabular-nums slashed-zero">
            <div data-stat="n"><dt class="text-muted">Stops</dt><dd class="text-sm font-bold">{{ count(s.n) }}</dd></div>
            <div data-stat="avg">
              <dt class="text-muted">Moyen</dt>
              <dd class="text-sm font-bold" [class.text-bear]="(s.avgPct ?? 0) < 0">{{ pct(s.avgPct) }}</dd>
            </div>
            <div data-stat="worst">
              <dt class="text-muted">Pire</dt>
              <dd class="text-sm font-bold" [class.text-bear]="(s.worstPct ?? 0) < 0">{{ pct(s.worstPct) }}</dd>
            </div>
          </dl>
        }
      </div>
    }
  `,
})
export class StopSlippageCard {
  readonly rows = input.required<readonly StopSlippage[]>();

  /** Book names only when several books are compared. */
  protected readonly showBook = computed(() => this.rows().length > 1);
  protected readonly label = BOOK_LABEL;
  protected readonly pct = formatSignedPercentFr;
  protected readonly count = formatCount;
}
