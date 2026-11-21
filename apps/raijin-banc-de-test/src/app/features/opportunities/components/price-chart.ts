import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import type { TokenRow } from '../../../shared/models/token';
import { PriceChartPlot } from './price-chart-plot';
import {
  CHART_RANGES,
  MIN_POINTS,
  RANGE_LABEL,
  chartSummary,
  chartTableRows,
  type MarkerKind,
} from './price-chart-data';
import { PriceChartStore } from './price-chart-store';

let nextId = 0;

/**
 * « Prix » section of the token detail: 6 h / 24 h toggle, chart, legend and a visually hidden data table.
 * Owns its PriceChartStore: the history is read when the detail opens and the queries are aborted when it closes.
 */
@Component({
  selector: 'app-price-chart',
  imports: [PriceChartPlot],
  providers: [PriceChartStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section [attr.aria-labelledby]="uid + '-title'" class="space-y-2" data-price-chart>
      <div class="flex items-center justify-between gap-2">
        <h3 [id]="uid + '-title'" class="text-xs font-semibold tracking-wide text-muted uppercase">Prix</h3>
        <div role="group" aria-label="Période du graphique" class="flex rounded-xl border border-line bg-surface-2 p-0.5">
          @for (r of ranges; track r) {
            <button
              type="button"
              class="press min-h-11 min-w-12 rounded-[10px] px-3 text-xs font-semibold tabular-nums slashed-zero"
              [class.seg-active]="store.range() === r"
              [class.text-muted]="store.range() !== r"
              [attr.aria-pressed]="store.range() === r"
              [attr.data-range]="r"
              (click)="store.setRange(r)"
            >
              {{ rangeLabel[r] }}
            </button>
          }
        </div>
      </div>

      @if (store.loading()) {
        <div data-chart-skeleton role="status" class="skeleton h-[200px] rounded-lg">
          <span class="sr-only">Chargement du graphique…</span>
        </div>
      } @else if (store.failed()) {
        <div data-chart-error role="status" class="flex h-[200px] items-center justify-center rounded-lg border border-dashed border-line px-4 text-center text-sm text-muted">
          Historique indisponible pour l’instant.
        </div>
      } @else if (store.points().length < minPoints) {
        <div data-chart-empty class="flex h-[200px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line px-4 text-center">
          <p class="text-sm font-semibold">Pas assez d’historique</p>
          <p class="text-xs text-muted">Le graphique se remplit à chaque scan (toutes les 2 min).</p>
        </div>
      } @else {
        <app-price-chart-plot [points]="store.points()" [markers]="store.markers()" [summary]="summary()" />
        @if (legend().length > 0) {
          <ul data-chart-legend class="flex flex-wrap gap-x-3 gap-y-1 text-label text-muted" aria-hidden="true">
            @for (k of legend(); track k) {
              <li class="flex items-center gap-1">
                <svg viewBox="-6 -7 12 12" class="size-3">
                  @switch (k) {
                    @case ('alert') { <path class="fill-info" d="M0 -6a3.2 3.2 0 0 1 3.2 3.2V0l1.6 2H-4.8L-3.2 0v-2.8A3.2 3.2 0 0 1 0 -6ZM-1.4 3a1.4 1.4 0 0 0 2.8 0Z" /> }
                    @case ('fill') { <path class="fill-bull" d="M0 -5L4.5 3.5H-4.5Z" /> }
                    @default { <path class="fill-warn" d="M0 5L4.5 -3.5H-4.5Z" /> }
                  }
                </svg>
                {{ legendLabel[k] }}
              </li>
            }
          </ul>
        }
        <table class="sr-only" data-chart-table>
          <caption>Données du graphique ({{ rangeLabel[store.range()] }}, heure de Paris)</caption>
          <tbody>
            @for (row of tableRows(); track $index) {
              <tr><th scope="row">{{ row.label }}</th><td>{{ row.value }}</td></tr>
            }
          </tbody>
        </table>
      }
      <p class="text-label text-muted">Prix relevés à chaque scan (toutes les 2 min), heure de Paris.</p>
    </section>
  `,
})
export class PriceChart {
  readonly token = input.required<TokenRow>();

  protected readonly store = inject(PriceChartStore);
  protected readonly uid = `price-chart-${++nextId}`;
  protected readonly ranges = CHART_RANGES;
  protected readonly rangeLabel = RANGE_LABEL;
  protected readonly minPoints = MIN_POINTS;
  protected readonly legendLabel: Record<MarkerKind, string> = {
    alert: 'Alerte',
    fill: 'Achat simulé',
    exit: 'Sortie simulée',
  };

  protected readonly summary = computed(() => chartSummary(this.token().symbol, this.store.range(), this.store.points()));
  protected readonly tableRows = computed(() => chartTableRows(this.store.points(), this.store.markers()));
  protected readonly legend = computed<MarkerKind[]>(() => {
    const kinds = new Set(this.store.markers().map((m) => m.kind));
    return (['alert', 'fill', 'exit'] as const).filter((k) => kinds.has(k));
  });

  constructor() {
    // Same mint → same signal value → no new query when Realtime updates the token.
    effect(() => this.store.setMint(this.token().mint));
    effect(() => this.store.setLive(this.token().price_usd, this.token().updated_at));
  }
}
