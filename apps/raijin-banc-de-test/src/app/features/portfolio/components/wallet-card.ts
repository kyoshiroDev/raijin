import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { BOOK_LABEL, formatSignedPercentFr, formatSignedSol, formatSolAmount } from '@raijin/bench-web-logic';
import { type BookView, pnlClass } from '@raijin/bench-web-logic/portfolio';

/** One virtual book: balance, open positions value, total P&L and the reset entry point, hidden when archived (presentational). */
@Component({
  selector: 'app-wallet-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-3', 'data-wallet': '' },
  template: `
    @let v = view();
    <dl class="grid grid-cols-2 gap-3 tabular-nums slashed-zero">
      <div class="col-span-2" data-wallet="balance">
        <dt class="text-xs text-muted">Solde virtuel · {{ label() }}</dt>
        <dd class="text-3xl font-black">{{ sol(v.wallet.balance_sol) }} <span class="text-base font-bold text-muted">SOL</span></dd>
      </div>
      <div data-wallet="open-value">
        <dt class="text-xs text-muted">Positions ouvertes</dt>
        <dd class="font-semibold">{{ sol(v.openValueSol) }} SOL</dd>
      </div>
      <div data-wallet="total-pnl">
        <dt class="text-xs text-muted">P&amp;L total</dt>
        <dd class="font-semibold" [class]="tone()">{{ signed(v.totalPnlSol) }}</dd>
        <dd class="text-xs" [class]="tone()">{{ pct(v.totalPnlPct) }}</dd>
      </div>
    </dl>
    <p class="text-xs text-muted tabular-nums slashed-zero" data-wallet="available">
      Disponible : <span class="text-fg">{{ sol(v.availableSol) }} SOL</span>
      @if (v.reservedSol > 0) { · {{ sol(v.reservedSol) }} SOL réservés par les ordres en attente }
    </p>
    <p class="text-label text-muted">P&amp;L total = clôturés + latent des positions ouvertes, sur un départ de {{ sol(v.wallet.initial_sol) }} SOL.</p>
    @if (archived()) {
      <p class="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted" data-archived>
        Portefeuille archivé : il n’ouvre plus de positions. Historique consultable en lecture seule.
      </p>
    } @else {
      <button type="button" class="btn-ghost w-full" data-reset [disabled]="busy()" (click)="resetRequested.emit()">Réinitialiser à 1 SOL</button>
    }
  `,
})
export class WalletCard {
  readonly view = input.required<BookView>();
  readonly busy = input(false);
  /** Archived book: no reset button, read-only notice instead. */
  readonly archived = input(false);
  readonly resetRequested = output();

  protected readonly label = computed(() => BOOK_LABEL[this.view().book]);
  protected readonly tone = computed(() => pnlClass(this.view().totalPnlSol));
  protected readonly sol = formatSolAmount;
  protected readonly signed = formatSignedSol;
  protected readonly pct = formatSignedPercentFr;
}
