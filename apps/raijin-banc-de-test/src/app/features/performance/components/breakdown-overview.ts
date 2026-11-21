import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { formatCount } from '../../../shared/utils/format';
import { formatHits, formatRate } from '../performance-stats';
import { formatMultiple, sampleNote, type BucketView } from '../performance-breakdown';
import { BucketRates } from './bucket-rates';

/** Overview of one source (its 'all' row): sample sizes first, then the rates (large only from n = 30). */
@Component({
  selector: 'app-breakdown-overview',
  imports: [BucketRates],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-3 p-3', 'data-overview': '' },
  template: `
    @let b = overall();
    <div class="flex items-baseline justify-between gap-2">
      <h3 class="text-sm font-semibold">Ensemble · {{ sourceLabel() }}</h3>
      <p class="text-xs tabular-nums slashed-zero" [class.text-muted]="!b.enough" [class.text-warn]="!b.enough && b.n > 0" data-sample>
        {{ note(b.n) }}
      </p>
    </div>
    <app-bucket-rates [bucket]="b" [prominent]="true" />
    <dl class="grid grid-cols-3 gap-x-3 border-t border-line pt-2 text-xs tabular-nums slashed-zero">
      <div data-stat="final"><dt class="text-label text-muted">Fenêtre 7 j close</dt><dd class="font-semibold">{{ count(b.nFinal) }}</dd></div>
      <div data-stat="dd50">
        <dt class="text-label text-muted">{{ b.dd50.label }}</dt>
        <dd class="font-semibold" [class.text-muted]="!b.enough">{{ rate(b.dd50.rate) }}</dd>
        <dd class="text-label text-muted">{{ hits(b.dd50.hits, b.n) }}</dd>
      </div>
      <div data-stat="median"><dt class="text-label text-muted">Multiple max médian</dt><dd class="font-semibold">{{ multiple(b.medianMultiple) }}</dd></div>
    </dl>
  `,
})
export class BreakdownOverview {
  readonly overall = input.required<BucketView>();
  readonly sourceLabel = input.required<string>();

  protected readonly note = sampleNote;
  protected readonly count = formatCount;
  protected readonly rate = formatRate;
  protected readonly hits = formatHits;
  protected readonly multiple = formatMultiple;
}
