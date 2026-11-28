import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { Sheet } from '../../shared/ui/sheet';
import { PaperTradePanel } from './paper-trade-panel';
import { Icon } from '../../shared/ui/icon';

/**
 * « Paper trade » button + its sheet (SIMULATION ONLY). The panel, and therefore its store and the API
 * reads, only exist while the sheet is open.
 */
@Component({
  selector: 'app-paper-trade-launcher',
  imports: [Icon, PaperTradePanel, Sheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <button type="button" class="btn-ghost w-full" data-paper-trade-button [disabled]="!hasPrice()" (click)="open.set(true)">
      <app-icon name="trend-up" class="size-4" />
      Paper trade
      <span class="text-xs font-normal text-muted">(simulation)</span>
    </button>
    @if (!hasPrice()) {
      <p class="mt-1 text-center text-label text-muted">Prix inconnu : paper trade indisponible.</p>
    }
    <app-sheet [heading]="'Paper trade · ' + symbol()" [(open)]="open">
      @if (open()) {
        <app-paper-trade-panel
          [mint]="mint()"
          [symbol]="symbol()"
          [currentPrice]="currentPrice()"
          [stake]="stake()"
          (closed)="open.set(false)"
        />
      }
    </app-sheet>
  `,
})
export class PaperTradeLauncher {
  readonly mint = input.required<string>();
  readonly symbol = input.required<string>();
  readonly currentPrice = input<number | null>(null);
  readonly stake = input.required<number>();

  protected readonly open = signal(false);
  /** Market entry only: a known current price is required. */
  protected readonly hasPrice = computed(() => {
    const p = this.currentPrice();
    return p !== null && Number.isFinite(p) && p > 0;
  });
}
