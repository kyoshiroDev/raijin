import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { SEO_OPPORTUNITY_POSITION, computeChange, type AdminSeo, type MetricUnit, type SeoRow, type SeoWindow } from '@raijin/shared-contracts';
import { AdminApi, createAdminReport } from '@raijin/web-data-access';
import { adminScreen } from '../../shell/admin-screens';
import {
  RjAdminFilters,
  RjAdminPageHeader,
  RjAdminPanel,
  RjChart,
  RjDataLagNotice,
  RjDataTable,
  RjKpiCard,
  RjKpiGrid,
  RjServiceState,
  formatDay,
  formatRange,
  type RjChartDataset,
  type RjTableColumn,
} from '../../ui';
import { RjAdminReportState, reloadOn } from '../shared/page-helpers';

interface Kpi {
  readonly label: string;
  readonly unit: MetricUnit;
  readonly value: number | null;
  readonly previous: number | null;
  readonly higherIsBetter: boolean;
}

const WINDOWS: readonly { value: SeoWindow; label: string }[] = [
  { value: '28d', label: '28 jours' },
  { value: '90d', label: '90 jours' },
];

/**
 * Écran 3 — SEO (API Search Console, cache 1 h) : clics, impressions, CTR, position moyenne sur 28 ou 90 jours,
 * requêtes et pages principales, requêtes en position 5 à 20 mises en avant. Décalage de 2 à 3 jours affiché.
 */
@Component({
  selector: 'rj-admin-seo-page',
  imports: [RjAdminPageHeader, RjAdminFilters, RjServiceState, RjDataLagNotice, RjKpiGrid, RjKpiCard, RjAdminPanel, RjChart, RjDataTable, RjAdminReportState],
  template: `
    <div class="flex flex-col gap-4 md:gap-6">
      <rj-admin-page-header [title]="screen.title" [description]="screen.description">
        <div rjHeaderMeta class="flex flex-wrap items-center gap-2 pt-1">
          @if (report.data(); as seo) {
            <rj-service-state service="search_console" [state]="seo.service" variant="inline" />
          }
        </div>
        <rj-admin-filters title="Fenêtre" description="Période d’analyse Search Console" [activeCount]="window() === '28d' ? 0 : 1">
          <fieldset class="min-w-0">
            <legend class="mb-1 text-label font-semibold text-ink-muted">Fenêtre</legend>
            <div class="inline-flex rounded-md border border-line bg-surface p-1">
              @for (option of windows; track option.value) {
                <label
                  class="relative inline-flex min-h-11 cursor-pointer items-center rounded-sm px-3 text-body-sm font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus-ring"
                  [class.bg-surface-raised]="option.value === window()"
                  [class.text-ink]="option.value === window()"
                  [class.text-ink-muted]="option.value !== window()"
                >
                  <input type="radio" name="rj-seo-window" class="absolute inset-0 cursor-pointer opacity-0" [value]="option.value" [checked]="option.value === window()" (change)="window.set(option.value)" />
                  {{ option.label }}
                </label>
              }
            </div>
          </fieldset>
        </rj-admin-filters>
      </rj-admin-page-header>

      <rj-admin-report-state [report]="report" [kpis]="4" (retry)="reload()">
        @if (report.data(); as seo) {
          @if (seo.data; as data) {
            <rj-data-lag-notice [dataThrough]="data.dataThrough" [lagDays]="data.lagDays" />
            <p class="text-body-sm text-ink-muted">{{ windowCaption() }}</p>
            <rj-kpi-grid>
              @for (kpi of kpis(); track kpi.label) {
                <rj-kpi-card [label]="kpi.label" [unit]="kpi.unit" [value]="kpi.value" [previous]="kpi.previous" [change]="change(kpi)" [higherIsBetter]="kpi.higherIsBetter" comparisonLabel="vs fenêtre préc." />
              }
            </rj-kpi-grid>

            <div class="grid gap-4 md:gap-6 xl:grid-cols-2">
              <rj-admin-panel title="Clics" description="Par jour">
                <rj-chart type="line" title="Clics par jour" unit="count" [labels]="chart().labels" [datasets]="chart().clicks" />
              </rj-admin-panel>
              <rj-admin-panel title="Impressions" description="Par jour">
                <rj-chart type="line" title="Impressions par jour" unit="count" [labels]="chart().labels" [datasets]="chart().impressions" />
              </rj-admin-panel>
            </div>

            <rj-admin-panel title="Requêtes à faire progresser" [description]="opportunityHint">
              <rj-data-table caption="Requêtes en position 5 à 20" [columns]="columns('Requête')" [rows]="data.opportunities" emptyText="Aucune requête entre la 5e et la 20e position sur cette fenêtre." />
            </rj-admin-panel>

            <div class="grid gap-4 md:gap-6 xl:grid-cols-2">
              <rj-admin-panel title="Requêtes principales">
                <rj-data-table caption="Requêtes principales" [columns]="columns('Requête')" [rows]="data.topQueries" />
              </rj-admin-panel>
              <rj-admin-panel title="Pages principales">
                <rj-data-table caption="Pages principales" [columns]="columns('Page')" [rows]="data.topPages" />
              </rj-admin-panel>
            </div>
          } @else {
            <rj-service-state service="search_console" [state]="seo.service" />
          }
        }
      </rj-admin-report-state>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminSeoPage {
  private readonly api = inject(AdminApi);
  protected readonly screen = adminScreen('seo');
  protected readonly windows = WINDOWS;
  protected readonly window = signal<SeoWindow>('28d');
  protected readonly report = createAdminReport<AdminSeo>();
  protected readonly opportunityHint = `Position moyenne entre ${SEO_OPPORTUNITY_POSITION.min} et ${SEO_OPPORTUNITY_POSITION.max}, triées par impressions : les plus faciles à faire monter.`;

  protected readonly windowCaption = computed(() => {
    const data = this.report.data()?.data;
    if (!data) return '';
    const text = formatRange(data.startDate, data.dataThrough);
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}, comparé à la fenêtre précédente de même longueur.`;
  });

  protected readonly kpis = computed<Kpi[]>(() => {
    const data = this.report.data()?.data;
    if (!data) return [];
    const before = data.previousTotals;
    return [
      { label: 'Clics', unit: 'count', value: data.totals.clicks, previous: before?.clicks ?? null, higherIsBetter: true },
      { label: 'Impressions', unit: 'count', value: data.totals.impressions, previous: before?.impressions ?? null, higherIsBetter: true },
      { label: 'CTR', unit: 'ratio', value: data.totals.ctr, previous: before?.ctr ?? null, higherIsBetter: true },
      // Une position plus petite est meilleure : la hausse de la valeur est mauvaise.
      { label: 'Position moyenne', unit: 'position', value: data.totals.position, previous: before?.position ?? null, higherIsBetter: false },
    ];
  });

  protected readonly chart = computed<{ labels: string[]; clicks: RjChartDataset[]; impressions: RjChartDataset[] }>(() => {
    const series = this.report.data()?.data?.series ?? [];
    return {
      labels: series.map((point) => formatDay(point.date)),
      clicks: [{ label: 'Clics', data: series.map((point) => point.clicks), tone: 'primary' }],
      impressions: [{ label: 'Impressions', data: series.map((point) => point.impressions), tone: 'info' }],
    };
  });

  private readonly columnCache = new Map<string, readonly RjTableColumn<SeoRow>[]>();

  constructor() {
    reloadOn(this.window, this.report, (window) => this.api.seo(window));
  }

  protected columns(label: string): readonly RjTableColumn<SeoRow>[] {
    let columns = this.columnCache.get(label);
    if (!columns) {
      columns = [
        { key: 'key', label, value: (row) => row.key, primary: true },
        { key: 'clicks', label: 'Clics', value: (row) => row.clicks, unit: 'count' },
        { key: 'impressions', label: 'Impressions', value: (row) => row.impressions, unit: 'count' },
        { key: 'ctr', label: 'CTR', value: (row) => row.ctr, unit: 'ratio' },
        { key: 'position', label: 'Position', value: (row) => row.position, unit: 'position' },
      ];
      this.columnCache.set(label, columns);
    }
    return columns;
  }

  protected reload(): void {
    void this.report.load(() => this.api.seo(this.window()));
  }

  protected change(kpi: Kpi): number | null {
    return computeChange(kpi.value, kpi.previous);
  }
}
