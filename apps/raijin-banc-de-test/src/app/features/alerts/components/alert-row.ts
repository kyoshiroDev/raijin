import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { shortAddress } from '@raijin/bench-web-logic';
import { formatAlertTime, type AlertItem, alertCells, alertOutcomeLine, alertStatus } from '@raijin/bench-web-logic/alerts';
import { AlertStatusBadge } from './alert-status-badge';
import { Icon } from '../../../shared/ui/icon';

/**
 * One alert. Single alerts show their OUTCOME (badge, entry → high → current with multiples) and the price cells;
 * legacy single alerts without a stored plan say so; grouped ones stay compact.
 */
@Component({
  selector: 'app-alert-row',
  imports: [AlertStatusBadge, Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @let a = item();
    <a [routerLink]="['/token', a.mint]" class="block min-h-14 space-y-2 px-4 py-3 hover:bg-surface-2">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <p class="truncate font-semibold">{{ a.symbol ?? shortMint() }}</p>
          <p class="truncate text-xs text-muted">
            <time [attr.datetime]="a.sent_at">{{ time() }}</time>
            @if (a.kind === 'grouped') { · Alerte groupée }
            @if (a.symbol !== null) { · <span class="font-mono">{{ shortMint() }}</span> }
          </p>
        </div>
        @if (detailed()) {
          <app-alert-status-badge class="shrink-0" [status]="status()" />
        }
        <app-icon name="chevron-right" class="size-4 text-muted" />
      </div>
      @if (a.kind === 'single') {
        @if (outcomeLine(); as line) {
          <p class="font-mono text-xs tabular-nums slashed-zero wrap-anywhere" data-outcome>{{ line }}</p>
        } @else {
          <p class="text-xs text-muted" data-legacy>Plan non enregistré</p>
        }
      }
      @if (detailed()) {
        <dl class="grid grid-cols-3 gap-x-2 gap-y-2 text-xs tabular-nums slashed-zero">
          @for (c of cells(); track c.label) {
            <div class="min-w-0">
              <dt class="truncate text-label text-muted">{{ c.label }}</dt>
              <dd class="truncate font-mono" [class.text-bull]="c.tone === 'bull'" [class.text-bear]="c.tone === 'bear'">{{ c.value }}</dd>
              @if (c.sub) {
                <dd class="truncate text-label text-muted">{{ c.sub }}</dd>
              }
            </div>
          }
        </dl>
      }
    </a>
  `,
})
export class AlertRow {
  readonly item = input.required<AlertItem>();
  /** Reference time (ms) for « il y a X min » and the end of tracking. */
  readonly now = input(Date.now());

  protected readonly shortMint = computed(() => shortAddress(this.item().mint));
  protected readonly time = computed(() => formatAlertTime(this.item().sent_at, this.now()));
  protected readonly detailed = computed(() => this.item().kind === 'single' && this.item().entry_price !== null);
  protected readonly status = computed(() => alertStatus(this.item(), this.now()));
  protected readonly outcomeLine = computed(() => alertOutcomeLine(this.item()));
  protected readonly cells = computed(() => alertCells(this.item(), this.now()));
}
