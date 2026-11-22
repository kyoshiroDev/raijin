import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DATA_SOURCE_NAMES, VERDICT_LABELS, type AdminPeriod, type AdminProduct } from '@raijin/shared-contracts';
import { AdminApi, createAdminReport } from '@raijin/web-data-access';
import { adminScreen } from '../../shell/admin-screens';
import {
  RjAdminPageHeader,
  RjAdminPanel,
  RjChart,
  RjDataTable,
  RjKpiCard,
  RjKpiGrid,
  RjPeriodSelect,
  RjRangeCaption,
  timeSeriesToChart,
  type RjChartDataset,
  type RjTableColumn,
} from '../../ui';
import { ADMIN_PAGE_PERIODS, RjAdminReportState, comparisonLabel, previousLabel, reloadOn } from '../shared/page-helpers';

type TokenRow = AdminProduct['topTokens'][number];

/** Adresse raccourcie « DezX…B263 » (lisible sur mobile). */
function truncateMiddle(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
type SourceRow = AdminProduct['unavailableBySource'][number];

/**
 * Écran 8 — Produit : analyses par jour, répartition des verdicts (icône + mot), tokens les plus analysés (symboles
 * on-chain hostiles, affichés en texte), temps de réponse moyen et p95, contrôles « indisponibles » par source.
 */
@Component({
  selector: 'rj-admin-product-page',
  imports: [RjAdminPageHeader, RjPeriodSelect, RjRangeCaption, RjKpiGrid, RjKpiCard, RjAdminPanel, RjChart, RjDataTable, RjAdminReportState],
  template: `
    <div class="flex flex-col gap-4 md:gap-6">
      <rj-admin-page-header [title]="screen.title" [description]="screen.description">
        <div rjHeaderMeta class="pt-1">
          @if (report.data(); as product) {
            <rj-range-caption [range]="product.range" />
          }
        </div>
        <rj-period-select [(period)]="period" [periods]="periods" />
      </rj-admin-page-header>

      <rj-admin-report-state [report]="report" [kpis]="5" (retry)="reload()">
        @if (report.data(); as product) {
          <rj-kpi-grid>
            <rj-kpi-card label="Analyses" [value]="product.analysesTotal" />
            <rj-kpi-card label="Temps de réponse moyen" unit="ms" [value]="product.responseTimeMs.average" [status]="product.responseTimeMs.average === null ? 'unavailable' : 'ok'" />
            <rj-kpi-card label="Temps de réponse p95" unit="ms" [value]="product.responseTimeMs.p95" [status]="product.responseTimeMs.p95 === null ? 'unavailable' : 'ok'" />
            <rj-kpi-card label="Scans de wallet" [value]="product.walletScans" />
            <rj-kpi-card label="Suivis actifs" [value]="product.activeWatches" />
          </rj-kpi-grid>

          <div class="grid gap-4 md:gap-6 xl:grid-cols-3">
            <div class="xl:col-span-2">
              <rj-admin-panel title="Analyses par jour" [description]="'Avec la période précédente (' + comparison() + ')'">
                <rj-chart type="line" title="Analyses par jour" unit="count" [labels]="analyses().labels" [datasets]="analyses().datasets" />
              </rj-admin-panel>
            </div>
            <rj-admin-panel title="Verdicts" description="Répartition des analyses de la période">
              <rj-chart type="doughnut" title="Répartition des verdicts" unit="count" categoryLabel="Verdict" height="sm" [labels]="verdicts().labels" [datasets]="verdicts().datasets" />
            </rj-admin-panel>
          </div>

          <rj-admin-panel title="Temps de réponse" description="Durée moyenne d’une analyse (collecte + moteur), par jour">
            <rj-chart type="line" title="Temps de réponse moyen" unit="ms" [labels]="timing().labels" [datasets]="timing().datasets" />
          </rj-admin-panel>

          <div class="grid gap-4 md:gap-6 xl:grid-cols-2">
            <rj-admin-panel title="Tokens les plus analysés" description="Nom et symbole déclarés on-chain, non vérifiés">
              <rj-data-table caption="Tokens les plus analysés" [columns]="tokenColumns" [rows]="product.topTokens" [trackBy]="byMint" />
            </rj-admin-panel>
            <rj-admin-panel title="Contrôles indisponibles" description="Part des contrôles sans réponse de la source">
              <rj-data-table caption="Indisponibilité par source" [columns]="sourceColumns" [rows]="product.unavailableBySource" />
            </rj-admin-panel>
          </div>
        }
      </rj-admin-report-state>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminProductPage {
  private readonly api = inject(AdminApi);
  protected readonly screen = adminScreen('produit');
  protected readonly periods = ADMIN_PAGE_PERIODS;
  protected readonly period = signal<AdminPeriod>('30d');
  protected readonly report = createAdminReport<AdminProduct>();
  protected readonly comparison = computed(() => comparisonLabel(this.period()));
  protected readonly byMint = (row: TokenRow) => row.mint;

  protected readonly analyses = computed(() => {
    const data = this.report.data();
    return data ? timeSeriesToChart(data.analysesSeries, { current: 'Analyses', comparison: previousLabel(this.period()) }) : { labels: [], datasets: [] };
  });

  protected readonly timing = computed(() => {
    const data = this.report.data();
    return data ? timeSeriesToChart(data.responseTimeSeries, { current: 'Temps moyen', comparison: previousLabel(this.period()) }) : { labels: [], datasets: [] };
  });

  protected readonly verdicts = computed<{ labels: string[]; datasets: RjChartDataset[] }>(() => {
    const split = this.report.data()?.verdictSplit;
    return {
      labels: [VERDICT_LABELS.safe, VERDICT_LABELS.warn, VERDICT_LABELS.danger],
      datasets: [{ label: 'Analyses', data: [split?.safe ?? 0, split?.warn ?? 0, split?.danger ?? 0], tone: 'primary', tones: ['safe', 'warn', 'danger'] }],
    };
  });

  protected readonly tokenColumns: readonly RjTableColumn<TokenRow>[] = [
    { key: 'symbol', label: 'Token', value: (row) => row.symbol ?? row.name ?? truncateMiddle(row.mint), primary: true },
    { key: 'name', label: 'Nom', value: (row) => row.name, hideOnMobile: true },
    { key: 'mint', label: 'Mint', value: (row) => truncateMiddle(row.mint), mono: true },
    { key: 'analyses', label: 'Analyses', value: (row) => row.analyses, unit: 'count' },
  ];

  protected readonly sourceColumns: readonly RjTableColumn<SourceRow>[] = [
    { key: 'source', label: 'Source', value: (row) => DATA_SOURCE_NAMES[row.source], primary: true },
    { key: 'checks', label: 'Contrôles', value: (row) => row.checks, unit: 'count' },
    { key: 'unavailable', label: 'Indisponibles', value: (row) => row.unavailable, unit: 'count' },
    { key: 'rate', label: 'Taux', value: (row) => row.rate, unit: 'ratio' },
  ];

  constructor() {
    reloadOn(this.period, this.report, (period) => this.api.product({ period }));
  }

  protected reload(): void {
    void this.report.load(() => this.api.product({ period: this.period() }));
  }
}
