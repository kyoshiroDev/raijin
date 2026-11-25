import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { type TokenRow, formatPct, formatPrice, formatUsd, formatPriceCompact } from '@raijin/bench-web-logic';
import { Sparkline } from '../../../shared/ui/sparkline';
import { LiquidityInfo } from './liquidity-info';

/**
 * Key numbers of the card (tiny prices in subscript-zero notation on one line, 12 px under 360 px, full price as screen-reader
 * text): muted labels, prominent tabular values. Price · MC · effective liquidity on the
 * first row, 1 h · 24 h · 6 h sparkline on the second (fixed row heights, « – » when the sparkline is unknown).
 */
@Component({
  selector: 'app-token-card-stats',
  imports: [LiquidityInfo, Sparkline],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    @let t = token();
    <dl class="grid grid-cols-[minmax(0,3fr)_minmax(0,3fr)_minmax(0,4fr)] gap-x-3 gap-y-2 tabular-nums slashed-zero" data-stats>
      <div class="min-w-0">
        <dt class="text-label text-muted">Prix</dt>
        <dd class="truncate font-mono text-xs font-semibold xs:text-sm" data-price>
          <span aria-hidden="true">{{ compactPrice(t.price_usd) }}</span><span class="sr-only">{{ fmtPrice(t.price_usd) }}</span>
        </dd>
      </div>
      <div class="min-w-0">
        <dt class="text-label text-muted">MC</dt>
        <dd class="truncate text-sm font-semibold">{{ fmtUsd(t.market_cap) }}</dd>
      </div>
      <div class="min-w-0">
        <dt class="text-label text-muted">Liquidité</dt>
        <dd class="text-sm font-semibold"><app-liquidity-info [token]="t" /></dd>
      </div>
      <div class="min-w-0">
        <dt class="text-label text-muted">1 h</dt>
        <dd class="text-sm font-semibold" [class.text-bull]="t.change_1h > 0" [class.text-bear]="t.change_1h < 0">{{ fmtPct(t.change_1h) }}</dd>
      </div>
      <div class="min-w-0">
        <dt class="text-label text-muted">24 h</dt>
        <dd class="text-sm font-semibold" [class.text-bull]="t.change_24h > 0" [class.text-bear]="t.change_24h < 0">
          {{ fmtPct(t.change_24h) }}
        </dd>
      </div>
      <div class="min-w-0" data-spark-cell>
        <dt class="text-label text-muted">6 h</dt>
        <dd class="flex h-5 items-center">
          @if (t.spark_6h) {
            <app-sparkline class="h-5 w-full" [values]="t.spark_6h" />
          } @else {
            <span class="text-sm text-muted">–</span>
          }
        </dd>
      </div>
    </dl>
  `,
})
export class TokenCardStats {
  readonly token = input.required<TokenRow>();

  protected readonly fmtPrice = formatPrice;
  protected readonly compactPrice = formatPriceCompact;
  protected readonly fmtUsd = formatUsd;
  protected readonly fmtPct = formatPct;
}
