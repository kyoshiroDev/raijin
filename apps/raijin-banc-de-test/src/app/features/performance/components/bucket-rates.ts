import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { formatHits, formatRate } from '../performance-stats';
import type { BucketView } from '../performance-breakdown';

/** What the rates need: a breakdown bucket, or a preset card (n = labelled signals). */
export type RatesView = Pick<BucketView, 'n' | 'enough' | 'rates'>;

/**
 * The four rates of a bucket (×2, ×2 before −30 %, −30 % before ×2, ×3), hits / n always written.
 * RULE: under 30 labelled rows a rate is never prominent — small, muted, no colour. `prominent` (overview only)
 * enlarges the rates only when the sample is large enough.
 */
@Component({
  selector: 'app-bucket-rates',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @let b = bucket();
    <dl class="grid grid-cols-2 gap-x-3 gap-y-2 tabular-nums slashed-zero">
      @for (r of b.rates; track r.key) {
        <div class="min-w-0" [attr.data-rate]="r.key">
          <dt class="text-label text-muted">{{ r.label }}</dt>
          @if (b.enough) {
            <dd
              [class]="prominent() ? 'text-2xl font-black' : 'text-sm font-bold'"
              [class.text-bull]="r.tone === 'bull'"
              [class.text-bear]="r.tone === 'bear'"
              data-rate-value
            >
              {{ rate(r.rate) }}
            </dd>
            <dd class="text-label text-muted">{{ hits(r.hits, b.n) }}</dd>
          } @else {
            <dd class="text-xs text-muted" data-small-sample>{{ rate(r.rate) }} · {{ hits(r.hits, b.n) }}</dd>
          }
        </div>
      }
    </dl>
  `,
})
export class BucketRates {
  readonly bucket = input.required<RatesView>();
  readonly prominent = input(false);

  protected readonly rate = formatRate;
  protected readonly hits = formatHits;
}
