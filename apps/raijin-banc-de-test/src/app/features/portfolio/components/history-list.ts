import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { STRATEGY_LABEL, type PaperPosition, formatSignedSol, formatSolAmount } from '@raijin/bench-web-logic';
import { LEG_CLASS, LEG_LABEL, STATUS_CLASS, STATUS_LABEL, formatDateTimeFr, pnlClass } from '@raijin/bench-web-logic/portfolio';

/** Closed, cancelled and expired positions, most recent first (presentational). */
@Component({
  selector: 'app-history-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (positions().length === 0) {
      <p class="card text-sm text-muted" data-empty-history>Aucune position clôturée pour l’instant.</p>
    } @else {
      <ul class="card divide-y divide-line p-0" aria-label="Positions clôturées">
        @for (p of positions(); track p.id) {
          <li class="space-y-1 px-3 py-2.5 text-xs tabular-nums slashed-zero" [attr.data-history]="p.status">
            <div class="flex items-center gap-2">
              <p class="min-w-0 flex-1 truncate text-sm font-semibold">{{ p.symbol || '—' }}</p>
              @if (p.status === 'closed') {
                @for (l of p.legs; track l.id) {
                  <span class="pill" [class]="legClass[l.status]">{{ legLabel[l.status] }}</span>
                }
              } @else {
                <span class="pill" [class]="statusClass[p.status]">{{ statusLabel[p.status] }}</span>
              }
            </div>
            <div class="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-muted">
              <span>{{ date(p.closed_at ?? p.created_at) }}</span>
              <span>{{ strategyLabel[p.strategy] }}</span>
              <span>Mise {{ sol(p.stake_sol) }} SOL</span>
              <span>Frais {{ p.fees_sol === null ? '–' : sol(p.fees_sol) + ' SOL' }}</span>
              <span class="font-semibold" [class]="tone(p.pnl_sol)" data-history-pnl>{{ signed(p.pnl_sol) }}</span>
            </div>
          </li>
        }
      </ul>
    }
  `,
})
export class HistoryList {
  readonly positions = input.required<readonly PaperPosition[]>();

  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statusClass = STATUS_CLASS;
  protected readonly legLabel = LEG_LABEL;
  protected readonly legClass = LEG_CLASS;
  protected readonly strategyLabel = STRATEGY_LABEL;
  protected readonly sol = formatSolAmount;
  protected readonly signed = formatSignedSol;
  protected readonly date = formatDateTimeFr;
  protected readonly tone = pnlClass;
}
