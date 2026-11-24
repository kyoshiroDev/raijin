import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { sampleNote, type DimensionView } from '@raijin/bench-web-logic/performance';
import { BucketRates } from './bucket-rates';

let nextId = 0;

/** One dimension (DEX, MC, liquidity) as a list of buckets, each with its sample size and its four rates. */
@Component({
  selector: 'app-bucket-list',
  imports: [BucketRates],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-2 p-3', '[attr.data-dimension]': 'dimension().id' },
  template: `
    @let d = dimension();
    <h3 [id]="uid" class="text-sm font-semibold">{{ d.title }}</h3>
    <ul class="divide-y divide-line" [attr.aria-labelledby]="uid">
      @for (b of d.buckets; track b.bucket) {
        <li class="space-y-2 py-2.5" [attr.data-bucket]="b.bucket" [attr.data-small]="b.enough ? null : ''">
          <div class="flex items-baseline justify-between gap-2">
            <span class="min-w-0 text-sm font-medium wrap-anywhere">{{ b.label }}</span>
            <span class="shrink-0 text-xs text-muted tabular-nums slashed-zero" data-sample>{{ note(b.n) }}</span>
          </div>
          <app-bucket-rates [bucket]="b" />
        </li>
      } @empty {
        <li class="py-2 text-sm text-muted" data-empty-dimension>Aucune donnée étiquetée pour cette source.</li>
      }
    </ul>
  `,
})
export class BucketList {
  readonly dimension = input.required<DimensionView>();

  protected readonly uid = `bucket-list-${++nextId}`;
  protected readonly note = sampleNote;
}
