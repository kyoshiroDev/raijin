import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { type RankedVariant, formatCi, formatInt, metricLines } from '@raijin/bench-web-logic/strategy-lab';

/**
 * One retained variant: rank, French name, « robuste » badge, test bootstrap interval, then the training and test
 * metrics side by side (presentational; fixed French copy, numbers only).
 */
@Component({
  selector: 'app-variant-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-2 p-3', '[attr.data-variant]': 'variant().id', '[attr.data-robust]': "variant().robust ? '' : null" },
  template: `
    <div class="flex items-start gap-2">
      <span class="shrink-0 font-black text-muted tabular-nums" aria-hidden="true">#{{ rank() }}</span>
      <h3 class="min-w-0 flex-1 text-sm leading-snug font-semibold" data-variant-name>
        <span class="sr-only">Rang {{ rank() }} : </span>{{ variant().name }}
      </h3>
      @if (variant().robust) {
        <span class="pill shrink-0 bg-bull/15 text-bull" data-robust-badge>Robuste</span>
      }
    </div>
    <p class="text-label text-muted tabular-nums slashed-zero" data-ci>
      Intervalle à 95 % du gain moyen (test) : {{ ci() }}
      @if (variant().test?.ciContainsZero) { — contient 0, résultat peut-être dû au hasard }
    </p>
    <table class="w-full text-xs tabular-nums slashed-zero">
      <caption class="sr-only">Apprentissage et test de cette variante</caption>
      <thead>
        <tr class="text-muted">
          <th scope="col" class="py-1 text-left font-normal"><span class="sr-only">Indicateur</span></th>
          <th scope="col" class="pl-1 text-right font-semibold">Apprentissage</th>
          <th scope="col" class="pl-1 text-right font-semibold">Test</th>
        </tr>
      </thead>
      <tbody>
        @for (l of lines(); track l.key) {
          <tr class="border-t border-line" [attr.data-metric]="l.key">
            <th scope="row" class="py-1.5 text-left font-normal text-muted">{{ l.label }}</th>
            <td class="pl-1 text-right">{{ l.train }}</td>
            <td class="pl-1 text-right font-semibold" [class.text-bull]="l.testSign === 1" [class.text-bear]="l.testSign === -1">{{ l.test }}</td>
          </tr>
        }
      </tbody>
    </table>
    @if (openAtEnd() > 0) {
      <p class="text-label text-muted" data-open-at-end>{{ openAtEndText() }}</p>
    }
  `,
})
export class VariantCard {
  readonly variant = input.required<RankedVariant>();
  readonly rank = input.required<number>();
  protected readonly lines = computed(() => metricLines(this.variant().train, this.variant().test));
  protected readonly ci = computed(() => formatCi(this.variant().test?.ciLow ?? null, this.variant().test?.ciHigh ?? null));
  protected readonly openAtEnd = computed(() => (this.variant().train?.openAtEnd ?? 0) + (this.variant().test?.openAtEnd ?? 0));
  protected readonly openAtEndText = computed(
    () => `${formatInt(this.openAtEnd())} trade(s) encore ouvert(s) en fin de données, vendus à la dernière clôture connue.`,
  );
}
