import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Proportion } from '@raijin/bench-verdicts';
import { formatCount, formatInterval, formatPct } from '../verdict-quality-format';

/**
 * Une proportion du banc : valeur, intervalle de Wilson à 95 % et effectif. Sous l'effectif minimal,
 * jamais de pourcentage : « échantillon insuffisant » et n seulement (aucun chiffre réutilisable).
 */
@Component({
  selector: 'app-proportion-value',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @let v = p();
    @if (v.insufficient) {
      <span class="block text-sm font-semibold text-warn" data-insufficient>Échantillon insuffisant</span>
      <span class="block text-xs text-muted" data-n>n = {{ v.total }} (minimum {{ minSample() }})</span>
    } @else {
      <span class="block font-black tabular-nums" [class]="compact() ? 'text-value' : 'text-2xl'" data-value>{{ pct(v.value) }}</span>
      <span class="block text-xs text-muted tabular-nums" data-interval>{{ interval(v) }}</span>
      <span class="block text-xs text-muted tabular-nums" data-n>{{ count(v) }}</span>
    }
  `,
})
export class ProportionValue {
  readonly p = input.required<Proportion>();
  readonly minSample = input(30);
  readonly compact = input(false);
  protected readonly pct = formatPct;
  protected readonly interval = formatInterval;
  protected readonly count = formatCount;
}
