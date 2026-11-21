import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { TokenRow } from '../../../shared/models/token';
import { rugcheckHistoryStats, rugcheckStats } from '../token-display';
import { StatGrid } from './stat-grid';

/** RugCheck data of the detail. Danger labels are third-party (hostile) text: interpolation only. */
@Component({
  selector: 'app-rugcheck-summary',
  imports: [StatGrid],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block space-y-2' },
  template: `
    @let t = token();
    <p class="text-xs font-semibold text-muted">RugCheck</p>
    <app-stat-grid [stats]="stats()" />
    @if (t.rugcheck_dangers.length) {
      <ul class="flex flex-wrap gap-1.5" aria-label="Dangers signalés par RugCheck">
        @for (d of t.rugcheck_dangers; track d) {
          <li class="pill max-w-full bg-bear/10 wrap-anywhere text-bear"><span aria-hidden="true">✕&nbsp;</span>{{ d }}</li>
        }
      </ul>
    } @else if (t.rugcheck_at) {
      <p class="text-sm text-muted">Aucun danger signalé par RugCheck.</p>
    } @else {
      <p class="text-sm text-muted">RugCheck : pas encore analysé.</p>
    }
  `,
})
export class RugcheckSummary {
  readonly token = input.required<TokenRow>();
  protected readonly stats = computed(() => [...rugcheckStats(this.token()), ...rugcheckHistoryStats(this.token())]);
}
