import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SimulationBanner } from '../../shared/ui/simulation-banner';
import { formatSolAmount } from '../../shared/utils/format';
import { PaperTradeForm } from './components/paper-trade-form';
import { UserPreferences } from '../../core/preferences/user-preferences';
import { prefillDraft, type PaperDraft } from './paper-strategy';
import { PaperTradeStore } from './paper-trade-store';

/** Paper trade content of the sheet (smart). Created only while the sheet is open; provides its store. */
@Component({
  selector: 'app-paper-trade-panel',
  imports: [PaperTradeForm, RouterLink, SimulationBanner],
  providers: [PaperTradeStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block space-y-4' },
  template: `
    <app-simulation-banner />
    @if (store.state() === 'done') {
      <div class="space-y-3 text-center" role="status" data-paper-done>
        <p class="font-semibold text-bull">Paper trade enregistré sur {{ symbol() }} (simulation).</p>
        <a routerLink="/portfolio" class="btn-ghost w-full" (click)="closed.emit()">Voir mon portefeuille</a>
        <button type="button" class="btn w-full text-muted" (click)="closed.emit()">Fermer</button>
      </div>
    } @else if (initial(); as draft) {
      <p class="text-sm text-muted tabular-nums slashed-zero" data-balance>
        @if (store.available() !== null) {
          Solde virtuel disponible (Principal) : <span class="text-fg">{{ sol(store.available()) }} SOL</span>
        } @else if (store.loadError()) {
          Solde virtuel indisponible pour l’instant.
        } @else {
          <span class="skeleton inline-block h-3.5 w-48 align-middle" aria-hidden="true"></span>
          <span class="sr-only" role="status">Chargement du solde virtuel…</span>
        }
      </p>
      <app-paper-trade-form
        [initial]="draft"
        [available]="store.available()"
        [submitting]="store.state() === 'pending'"
        [error]="store.error()"
        (submitted)="place($event)"
      />
    } @else {
      <p class="text-sm text-muted">Prix inconnu : impossible de préparer un paper trade pour ce token.</p>
    }
    <p class="text-label text-muted">Position fictive suivie par Raijin-banc-de-test. Aucun wallet, aucune transaction réelle.</p>
  `,
})
export class PaperTradePanel implements OnInit {
  readonly mint = input.required<string>();
  readonly symbol = input.required<string>();
  readonly currentPrice = input<number | null>(null);
  /** The user's usual stake (UserPreferences). */
  readonly stake = input.required<number>();
  readonly closed = output();

  protected readonly store = inject(PaperTradeStore);
  private readonly preferences = inject(UserPreferences);
  protected readonly sol = formatSolAmount;
  /** Market entry at the current price, pre-filled with the default stop (settings) and the usual stake. */
  protected readonly initial = computed(() =>
    prefillDraft(this.currentPrice(), { stake: this.stake(), slPct: this.preferences.paperSlPct() }),
  );

  ngOnInit(): void {
    void this.store.load();
  }

  protected place(draft: PaperDraft): void {
    void this.store.submit(draft, this.mint());
  }
}
