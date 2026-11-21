import { ChangeDetectionStrategy, Component, type OnInit, inject } from '@angular/core';
import { PageHeader } from '../../shared/ui/page-header';
import { SimulationBanner } from '../../shared/ui/simulation-banner';
import { BalanceCurveChart } from './components/balance-curve-chart';
import { BookComparison } from './components/book-comparison';
import { BookSelector } from './components/book-selector';
import { HistoryList } from './components/history-list';
import { PositionList } from './components/position-list';
import { ResetWalletSheet } from './components/reset-wallet-sheet';
import { StopSlippageCard } from './components/stop-slippage-card';
import { StrategyStatsCard } from './components/strategy-stats-card';
import { WalletCard } from './components/wallet-card';
import { PortfolioStore } from './portfolio-store';
import { Skeleton } from '../../shared/ui/skeleton';

/** /portfolio — virtual books, open positions, stats per strategy, balance curve and history (SIMULATION ONLY). */
@Component({
  selector: 'app-portfolio-page',
  imports: [BalanceCurveChart, BookComparison, BookSelector, HistoryList, PageHeader, PositionList, ResetWalletSheet, SimulationBanner, Skeleton, StopSlippageCard, StrategyStatsCard, WalletCard],
  providers: [PortfolioStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header>
      <h1 class="text-xl font-black tracking-tight">Portefeuille</h1>
    </app-page-header>
    <main class="mx-auto max-w-lg space-y-5 px-safe pt-4">
      <app-simulation-banner />
      @if (store.error(); as e) {
        <div class="card space-y-3 text-center" role="alert">
          <p class="text-sm text-bear">{{ e }}</p>
          <button type="button" class="btn-ghost w-full" [disabled]="store.loading()" (click)="store.load()">Réessayer</button>
        </div>
      } @else if (!store.loaded()) {
        <app-skeleton variant="wallet" label="Chargement du portefeuille virtuel…" />
      } @else {
        @let v = store.view();
        @if (store.hasParallel()) {
          <app-book-selector [books]="store.books()" [value]="store.selectedBook()" (valueChange)="store.selectBook($event)" />
        }
        <app-wallet-card [view]="v" [busy]="store.resetting()" [archived]="store.selectedArchived()" (resetRequested)="store.requestReset(v.book)" />
        @if (store.feedback(); as f) {
          <p class="text-center text-sm" [class.text-bull]="f.kind === 'ok'" [class.text-bear]="f.kind === 'error'" role="status">{{ f.text }}</p>
        }

        <section aria-labelledby="portfolio-positions" class="space-y-2">
          <h2 id="portfolio-positions" class="text-xs font-semibold tracking-wide text-muted uppercase">Positions ouvertes et en attente</h2>
          <app-position-list [positions]="v.active" [busyId]="store.busyId()" [readOnly]="store.selectedArchived()" (cancelPosition)="store.cancel($event)" />
        </section>

        <section aria-labelledby="portfolio-curve" class="space-y-2">
          <h2 id="portfolio-curve" class="text-xs font-semibold tracking-wide text-muted uppercase">Évolution du solde</h2>
          <app-balance-curve-chart [points]="v.curve" />
        </section>

        <section aria-labelledby="portfolio-stats" class="space-y-2">
          <h2 id="portfolio-stats" class="text-xs font-semibold tracking-wide text-muted uppercase">Statistiques par stratégie</h2>
          @for (s of v.strategies; track s.strategy) {
            <app-strategy-stats-card [stats]="s" />
          } @empty {
            <p class="card text-sm text-muted" data-empty-stats>Aucun trade clôturé pour l’instant.</p>
          }
          <p class="text-xs text-muted">Trades = positions exécutées puis clôturées (entrées expirées ou annulées exclues). Taux de TP / SL par jambe clôturée, affichés en % à partir de 30.</p>
        </section>

        <section aria-labelledby="portfolio-slippage" class="space-y-2">
          <h2 id="portfolio-slippage" class="text-xs font-semibold tracking-wide text-muted uppercase">Glissement à la sortie sur stop</h2>
          <app-stop-slippage-card [rows]="store.stopSlippage()" />
        </section>

        @if (store.testComparison(); as c) {
          <section aria-labelledby="portfolio-compare-test" class="space-y-2" data-test-books-compare>
            <h2 id="portfolio-compare-test" class="text-xs font-semibold tracking-wide text-muted uppercase">Portefeuilles de test</h2>
            <p class="text-xs text-muted">
              Jeunes paires PumpSwap (&lt; 24 h), tout à ×2, entrée au prix du scan suivant. Calme avec un stop à −30 % ou
              à −40 %, Frénésie avec un stop à −30 %. Chaque token qui remplit le profil est simulé, indépendamment des
              alertes. Frénésie est un profil témoin : il n’envoie aucune alerte.
            </p>
            <app-book-comparison [books]="c" note="Même filtre de sécurité et de liquidité ; mise complète dans chaque portefeuille. Taux de TP par jambe clôturée." />
          </section>
        }

        <section aria-labelledby="portfolio-history" class="space-y-2">
          <h2 id="portfolio-history" class="text-xs font-semibold tracking-wide text-muted uppercase">Historique</h2>
          <app-history-list [positions]="v.history" />
        </section>
      }
      <p class="text-center text-label text-muted">
        Paper trading : positions fictives, prix issus du scanner, frais et slippage simulés. Aide à la décision, pas un conseil en investissement.
      </p>
    </main>
    <app-reset-wallet-sheet
      [book]="store.confirmingBook()"
      [busy]="store.resetting()"
      (confirmed)="store.confirmReset()"
      (dismissed)="store.dismissReset()"
    />
  `,
})
export class PortfolioPage implements OnInit {
  protected readonly store = inject(PortfolioStore);

  ngOnInit(): void {
    void this.store.load();
    this.store.listen();
  }
}
