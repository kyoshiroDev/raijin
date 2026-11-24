import { ChangeDetectionStrategy, Component, type OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PageHeader } from '../../shared/ui/page-header';
import { PerformanceSwitch } from '../../shared/ui/performance-switch';
import { BreakdownOverview } from './components/breakdown-overview';
import { BucketList } from './components/bucket-list';
import { PresetSection } from './components/preset-section';
import { TestBooksSection } from './components/test-books-section';
import { SOURCES } from './performance-breakdown';
import { MIN_SAMPLE_FOR_RATE } from './performance-stats';
import { BOOKS_LOAD_ERROR, PRESET_LOAD_ERROR, PerformanceStore } from './performance-store';

/**
 * /performance — the three test books, then « Calme vs Frénésie », then how the main scanner's past signals turned out (×2 / ×3, ×2 vs
 * −30 % order), overall and per bucket (DEX, MC, liquidity).
 */
@Component({
  selector: 'app-performance-page',
  imports: [BreakdownOverview, BucketList, PageHeader, PerformanceSwitch, PresetSection, RouterLink, TestBooksSection],
  providers: [PerformanceStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header>
      <h1 class="text-xl font-black tracking-tight">Performance</h1>
    </app-page-header>
    <main class="mx-auto max-w-lg space-y-4 px-safe pt-4">
      <app-performance-switch active="signals" />
      <a
        routerLink="/justesse"
        class="card press flex min-h-11 items-center justify-between gap-3 text-sm font-semibold hover:border-line-strong"
        data-verdict-quality-link
      >
        <span>Justesse des verdicts du moteur</span>
        <span aria-hidden="true" class="text-muted">→</span>
      </a>
      <a
        routerLink="/comparaison"
        class="card press flex min-h-11 items-center justify-between gap-3 text-sm font-semibold hover:border-line-strong"
        data-shadow-link
      >
        <span>Comparaison mode ombre (VPS / Supabase)</span>
        <span aria-hidden="true" class="text-muted">→</span>
      </a>
      <section aria-labelledby="perf-test-books">
        <app-test-books-section
          [state]="store.bookState()"
          [view]="store.bookComparison()"
          [errorText]="booksError"
          (retry)="store.loadBooks()"
        />
      </section>
      <section aria-labelledby="perf-presets">
        <app-preset-section
          [state]="store.presetState()"
          [comparison]="store.comparison()"
          [errorText]="presetError"
          (comparisonSegmentChange)="store.selectComparisonSegment($event)"
          (retry)="store.loadPresets()"
        />
      </section>

      <p class="text-xs text-muted" data-source-hint>{{ source.hint }}</p>

      @if (store.error(); as e) {
        <div class="card space-y-3 text-center" role="alert">
          <p class="text-sm text-bear">{{ e }}</p>
          <button type="button" class="btn-ghost w-full" [disabled]="store.loading()" (click)="store.load()">Réessayer</button>
        </div>
      } @else if (!store.loaded()) {
        <p class="py-10 text-center text-muted" role="status">Chargement des performances…</p>
      } @else if (store.unavailable()) {
        <p class="card text-sm text-muted" data-unavailable role="status">
          Les statistiques détaillées ne sont pas encore disponibles côté serveur. Reviens un peu plus tard.
        </p>
      } @else {
        @let v = store.view();
        <section aria-labelledby="perf-overview" class="space-y-2">
          <h2 id="perf-overview" class="text-xs font-semibold tracking-wide text-muted uppercase">Résultats des signaux</h2>
          @if (v.overall; as o) {
            <app-breakdown-overview [overall]="o" [sourceLabel]="source.label" />
          } @else {
            <p class="card text-sm text-muted" data-empty-source>Aucun signal étiqueté pour cette source pour l’instant.</p>
          }
          <p class="text-xs text-muted">
            Taux affichés en grand à partir de {{ minSample }} signaux étiquetés ; en dessous, en petit et en gris (échantillon trop petit).
          </p>
        </section>

        @if (v.overall) {
          <section aria-labelledby="perf-breakdowns" class="space-y-2">
            <h2 id="perf-breakdowns" class="text-xs font-semibold tracking-wide text-muted uppercase">Détail par tranche</h2>
            @for (d of v.dimensions; track d.id) {
              <app-bucket-list [dimension]="d" />
            }
          </section>
        }
      }
      <p class="text-center text-label text-muted" data-disclaimer>
        Résultats calculés à partir des bougies OHLCV de 15 minutes (GeckoTerminal), sur 7 jours après le signal.
        ×2 avant −30 % : le prix a doublé avant de perdre 30 % ; −30 % avant ×2 : l’inverse. n = signaux étiquetés.
        Résultats passés : aide à la décision, pas un conseil en investissement.
      </p>
    </main>
  `,
})
export class PerformancePage implements OnInit {
  protected readonly store = inject(PerformanceStore);
  protected readonly minSample = MIN_SAMPLE_FOR_RATE;
  protected readonly presetError = PRESET_LOAD_ERROR;
  protected readonly booksError = BOOKS_LOAD_ERROR;
  /** The main scanner, the only source left. */
  protected readonly source = SOURCES[0];

  ngOnInit(): void {
    void this.store.load();
  }
}
