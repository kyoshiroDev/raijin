import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { SummaryView } from '../lab-summary';

/**
 * Nightly verdict of the last finished backtest (backtest_runs.summary): « Aucune stratégie robuste » or
 * « Stratégie candidate : … » with the test / training figures, the run date and the sample size (presentational;
 * fixed French copy built by summaryView, rendered as text only).
 */
@Component({
  selector: 'app-lab-summary-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'card block space-y-1.5 p-3 data-[verdict=candidate]:border-bull/50',
    role: 'status',
    'data-lab-summary': '',
    '[attr.data-verdict]': 'summary().verdict',
  },
  template: `
    <p
      class="text-sm leading-snug font-bold"
      [class.text-bull]="summary().verdict === 'candidate'"
      data-summary-title
    >
      {{ summary().title }}
    </p>
    @for (d of summary().details; track $index) {
      <p class="text-xs text-muted tabular-nums slashed-zero" data-summary-detail>{{ d }}</p>
    }
    <p class="text-label text-muted tabular-nums" data-summary-meta>{{ summary().meta }}</p>
    @if (summary().verdict === 'candidate') {
      <p class="text-label text-warn" data-summary-caveat>
        Candidate sur données passées seulement : à confirmer, pas un conseil en investissement.
      </p>
    }
  `,
})
export class LabSummaryBanner {
  readonly summary = input.required<SummaryView>();
}
