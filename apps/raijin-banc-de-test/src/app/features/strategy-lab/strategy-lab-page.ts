import { ChangeDetectionStrategy, Component, type OnInit, computed, inject } from '@angular/core';
import { EmptyState } from '../../shared/ui/empty-state';
import { PageHeader } from '../../shared/ui/page-header';
import { PerformanceSwitch } from '../../shared/ui/performance-switch';
import { SimulationBanner } from '../../shared/ui/simulation-banner';
import { LAB_MSG, RESULT_FETCH_LIMIT } from './backtest';
import { BackfillGauge } from './components/backfill-gauge';
import { LabRunCard } from './components/lab-run-card';
import { LabSummaryBanner } from './components/lab-summary-banner';
import { NarrativeFilter } from './components/narrative-filter';
import { VariantCard } from './components/variant-card';
import { StrategyLabStore } from './strategy-lab-store';

/**
 * /performance/lab — « Laboratoire »: latest backtest run of the « Jeune calme » / « Jeune frénésie » presets (detection
 * and event modes, tout à ×2, SL −20 / −30 / −40 %, entry immediate or +2 min), retained variants ranked by their test
 * average net gain, training vs test side by side, « robuste » badge, narrative filter, manual re-run, the nightly
 * verdict banner and the server catch-up gauge. Past data only: the permanent note says a backtest does not predict the
 * future.
 */
@Component({
  selector: 'app-strategy-lab-page',
  imports: [BackfillGauge, EmptyState, LabRunCard, LabSummaryBanner, NarrativeFilter, PageHeader, PerformanceSwitch, SimulationBanner, VariantCard],
  providers: [StrategyLabStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header>
      <h1 class="text-xl font-black tracking-tight">Performance</h1>
    </app-page-header>
    <main class="mx-auto max-w-lg space-y-4 px-safe pt-4">
      <app-performance-switch active="lab" />

      @if (store.state() === 'ready' && store.summary(); as summary) {
        <app-lab-summary-banner [summary]="summary" />
      }

      <p class="card border-warn/40 text-xs text-muted" role="note" data-lab-disclaimer>
        <span class="font-semibold text-warn">Un backtest ne prédit pas le futur.</span>
        Il rejoue des signaux passés, frais compris, sur 70 % des données (apprentissage) puis vérifie sur les 30 % les plus
        récentes (test). Avec autant de variantes testées, quelques-unes paraissent « robustes » par pur hasard.
        Aide à la décision, pas un conseil en investissement.
      </p>

      @switch (store.state()) {
        @case ('unavailable') {
          <p class="card text-sm text-muted" role="status" data-lab-unavailable>{{ msg.unavailable }} Reviens un peu plus tard.</p>
        }
        @case ('error') {
          <div class="card space-y-3 text-center" role="alert">
            <p class="text-sm text-bear">{{ msg.loadFailed }}</p>
            <button type="button" class="btn-ghost w-full" (click)="store.load()">Réessayer</button>
          </div>
        }
        @case ('ready') {
          <section aria-labelledby="lab-run" class="space-y-2">
            <h2 id="lab-run" class="text-xs font-semibold tracking-wide text-muted uppercase">Dernier backtest</h2>
            <app-lab-run-card
              [latest]="store.latest()"
              [lastDone]="store.lastDone()"
              [running]="store.running()"
              [canRequest]="store.canRequest()"
              [requesting]="store.requesting()"
              [refreshing]="store.refreshing()"
              [feedback]="store.feedback()"
              (request)="store.requestRun()"
              (refresh)="store.refresh()"
            />
          </section>
        }
        @default {
          <p class="py-10 text-center text-muted" role="status">Chargement du laboratoire…</p>
        }
      }

      @if (showBackfill()) {
        <section aria-labelledby="lab-backfill" class="space-y-2">
          <h2 id="lab-backfill" class="text-xs font-semibold tracking-wide text-muted uppercase">Rattrapage des données</h2>
          <app-backfill-gauge [progress]="store.backfill()" [state]="store.backfillState()" />
        </section>
      }

      @if (store.state() === 'ready' && store.lastDone()) {
        <section aria-labelledby="lab-ranking" class="space-y-2">
          <h2 id="lab-ranking" class="text-xs font-semibold tracking-wide text-muted uppercase">Variantes retenues</h2>
          <app-narrative-filter [value]="store.narrative()" [counts]="store.counts()" (valueChange)="store.selectNarrative($event)" />
          <p class="text-xs text-muted">
            Grille : Jeune calme et Jeune frénésie (à la détection et à l’événement), tout à ×2, stop −20 / −30 / −40 %,
            entrée immédiate ou +2 min. Retenue : gain moyen net positif en apprentissage et en test, avec au moins 30
            trades en test. Robuste : en plus, l’intervalle à 95 % du test exclut 0. Classement par gain moyen net en
            test, mise de 0,1 SOL par trade.
          </p>
          @if (store.robustCount() === 0) {
            @if (store.variants().length === 0) {
              <app-empty-state title="Aucune variante robuste pour l’instant" hint="Aucune variante n’est retenue pour ce filtre." data-no-robust />
            } @else {
              <p class="card text-sm font-semibold" role="status" data-no-robust>Aucune variante robuste pour l’instant.</p>
            }
          }
          @for (v of store.variants(); track v.id; let i = $index) {
            <app-variant-card [variant]="v" [rank]="i + 1" />
          }
          @if (store.truncated()) {
            <p class="text-label text-muted" data-truncated>Liste limitée aux {{ limit }} premières lignes reçues.</p>
          }
        </section>
      }

      <app-simulation-banner />
    </main>
  `,
})
export class StrategyLabPage implements OnInit {
  protected readonly store = inject(StrategyLabStore);
  protected readonly msg = LAB_MSG;
  protected readonly limit = RESULT_FETCH_LIMIT;
  /** The catch-up gauge is independent of the laboratory tables: shown once the first load has answered. */
  protected readonly showBackfill = computed(() => this.store.state() !== 'idle' && this.store.state() !== 'loading');

  ngOnInit(): void {
    void this.store.load();
  }
}
