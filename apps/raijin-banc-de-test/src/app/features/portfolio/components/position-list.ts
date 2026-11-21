import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { STRATEGY_LABEL } from '../../../shared/models/paper';
import { formatPrice, formatSignedPercentFr, formatSignedSol, formatSolAmount } from '../../../shared/utils/format';
import type { PositionView } from '../paper-book';
import { STATUS_CLASS, STATUS_LABEL, formatDateTimeFr, pnlClass } from '../paper-display';
import { LegList } from './leg-list';
import { EmptyState } from '../../../shared/ui/empty-state';

/** Pending and open positions with their live P&L and legs (presentational). Symbols are hostile text: interpolated only. */
@Component({
  selector: 'app-position-list',
  imports: [EmptyState, LegList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (positions().length === 0) {
      <app-empty-state
        class="card py-0"
        data-empty-positions
        title="Aucune position ouverte ni en attente"
        hint="Lance un paper trade depuis la fiche d’un token."
      />
    } @else {
      <ul class="space-y-2" aria-label="Positions ouvertes et en attente">
        @for (v of positions(); track v.position.id) {
          @let p = v.position;
          <li class="card space-y-2 p-3 tabular-nums slashed-zero" [attr.data-position]="p.status">
            <div class="flex items-center gap-2">
              <p class="min-w-0 flex-1 truncate font-bold">{{ p.symbol || '—' }}</p>
              @if (p.source === 'auto_alert') { <span class="pill bg-surface-2 text-muted">Auto</span> }
              <span class="pill" [class]="statusClass[p.status]">{{ statusLabel[p.status] }}</span>
            </div>
            <p class="text-xs text-muted">{{ strategyLabel[p.strategy] }} · mise {{ sol(p.stake_sol) }} SOL</p>
            <dl class="grid grid-cols-3 gap-x-3 gap-y-1 text-xs *:min-w-0">
              <div><dt class="text-muted">{{ p.status === 'open' ? 'Achat' : 'Entrée visée' }}</dt><dd class="wrap-anywhere">{{ price(p.fill_price ?? p.entry_target_price) }}</dd></div>
              <div><dt class="text-muted">Prix actuel</dt><dd class="wrap-anywhere">{{ price(v.livePrice) }}</dd></div>
              @if (p.status === 'open') {
                <div data-pnl>
                  <dt class="text-muted">P&amp;L latent</dt>
                  @if (v.pnl; as pnl) {
                    <dd [class]="tone(pnl.pnlSol)">{{ signed(pnl.pnlSol) }}</dd>
                    <dd [class]="tone(pnl.pnlSol)">{{ pct(pnl.pnlPct) }}</dd>
                  } @else {
                    <dd class="text-muted">prix inconnu</dd>
                  }
                </div>
              } @else {
                <div><dt class="text-muted">Expire</dt><dd>{{ date(p.expires_at) }}</dd></div>
              }
            </dl>
            @if (v.legs.length > 0) { <app-leg-list [legs]="v.legs" /> }
            @if (p.status === 'pending' && !readOnly()) {
              <button
                type="button"
                class="btn-ghost w-full"
                data-cancel-position
                [disabled]="busyId() !== null"
                [attr.aria-label]="'Annuler la position en attente sur ' + (p.symbol || 'ce token')"
                (click)="cancelPosition.emit(p.id)"
              >
                {{ busyId() === p.id ? 'Annulation…' : 'Annuler' }}
              </button>
            }
          </li>
        }
      </ul>
    }
  `,
})
export class PositionList {
  readonly positions = input.required<readonly PositionView[]>();
  readonly busyId = input<string | null>(null);
  /** Archived book: pending positions cannot be cancelled from here. */
  readonly readOnly = input(false);
  readonly cancelPosition = output<string>();

  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statusClass = STATUS_CLASS;
  protected readonly strategyLabel = STRATEGY_LABEL;
  protected readonly sol = formatSolAmount;
  protected readonly price = formatPrice;
  protected readonly signed = formatSignedSol;
  protected readonly pct = formatSignedPercentFr;
  protected readonly date = formatDateTimeFr;
  protected readonly tone = pnlClass;
}
