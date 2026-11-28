import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  ACQUISITION_DIMENSIONS,
  ACQUISITION_DIMENSION_LABELS,
  ACQUISITION_DIRECT_LABEL,
  type AcquisitionDimension,
  type AcquisitionRow,
  type AdminAcquisition,
  type AdminPeriod,
} from '@raijin/shared-contracts';
import { AdminApi, createAdminReport } from '@raijin/web-data-access';
import { adminScreen } from '../../shell/admin-screens';
import {
  RjAdminFilters,
  RjAdminPageHeader,
  RjAdminPanel,
  RjChart,
  RjDataTable,
  RjKpiCard,
  RjKpiGrid,
  RjPeriodSelect,
  RjRangeCaption,
  RjServiceState,
  type RjChartDataset,
  type RjTableColumn,
} from '../../ui';
import { ADMIN_PAGE_PERIODS, RjAdminReportState, reloadOn } from '../shared/page-helpers';

/** Lignes affichées dans le graphique (les autres restent dans le tableau). */
const CHART_ROWS = 8;

/**
 * Écran 4 — Acquisition : inscrits, vérifiés, essais et payants par source UTM, support, campagne, page d'arrivée ou
 * site référent (jointure des données internes avec les sessions GA4 par source). Valeurs UTM hostiles : affichées
 * en texte, jamais interprétées.
 */
@Component({
  selector: 'rj-admin-acquisition-page',
  imports: [RjAdminPageHeader, RjPeriodSelect, RjRangeCaption, RjAdminFilters, RjServiceState, RjKpiGrid, RjKpiCard, RjAdminPanel, RjChart, RjDataTable, RjAdminReportState],
  template: `
    <div class="flex flex-col gap-4 md:gap-6">
      <rj-admin-page-header [title]="screen.title" [description]="screen.description">
        <div rjHeaderMeta class="flex flex-wrap items-center gap-2 pt-1">
          @if (report.data(); as acquisition) {
            <rj-range-caption [range]="acquisition.range" />
            <rj-service-state service="ga4" [state]="acquisition.ga4" variant="inline" />
          }
        </div>
        <rj-period-select [(period)]="period" [periods]="periods" />
        <rj-admin-filters title="Regrouper par" [activeCount]="dimension() === 'source' ? 0 : 1">
          <label class="flex min-w-0 flex-col gap-1">
            <span class="text-label font-semibold text-ink-muted">Regrouper par</span>
            <select
              class="min-h-11 rounded-md border border-line-strong bg-surface px-3 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              [value]="dimension()"
              (change)="setDimension($event)"
            >
              @for (option of dimensions; track option) {
                <option [value]="option" [selected]="option === dimension()">{{ dimensionLabels[option] }}</option>
              }
            </select>
          </label>
        </rj-admin-filters>
      </rj-admin-page-header>

      <rj-admin-report-state [report]="report" [kpis]="4" (retry)="reload()">
        @if (report.data(); as acquisition) {
          <rj-kpi-grid>
            <rj-kpi-card label="Inscrits" [value]="acquisition.totals.signups" />
            <rj-kpi-card label="Comptes vérifiés" [value]="acquisition.totals.verified" />
            <rj-kpi-card label="Essais commencés" [value]="acquisition.totals.trials" />
            <rj-kpi-card label="Devenus payants" [value]="acquisition.totals.payers" />
          </rj-kpi-grid>

          <rj-admin-panel [title]="'Inscrits par ' + dimensionLabels[acquisition.dimension].toLowerCase()" description="Inscriptions de la période et celles devenues payantes">
            <rj-chart type="bar" title="Inscrits et payants" unit="count" [horizontal]="true" [categoryLabel]="dimensionLabels[acquisition.dimension]" [labels]="chart().labels" [datasets]="chart().datasets" />
          </rj-admin-panel>

          <rj-admin-panel title="Détail" description="Conversion = payants / inscrits ; MRR actuel des payants de chaque ligne">
            @if (acquisition.dimension === 'source' && acquisition.ga4.status !== 'connected') {
              <rj-service-state service="ga4" [state]="acquisition.ga4" variant="inline" />
            }
            <rj-data-table [caption]="'Acquisition par ' + dimensionLabels[acquisition.dimension].toLowerCase()" [columns]="columns()" [rows]="acquisition.rows" emptyText="Aucune inscription sur cette période." />
          </rj-admin-panel>
        }
      </rj-admin-report-state>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminAcquisitionPage {
  private readonly api = inject(AdminApi);
  protected readonly screen = adminScreen('acquisition');
  protected readonly periods = ADMIN_PAGE_PERIODS;
  protected readonly dimensions = ACQUISITION_DIMENSIONS;
  protected readonly dimensionLabels = ACQUISITION_DIMENSION_LABELS;
  protected readonly period = signal<AdminPeriod>('30d');
  protected readonly dimension = signal<AcquisitionDimension>('source');
  protected readonly report = createAdminReport<AdminAcquisition>();
  private readonly query = computed(() => ({ period: this.period(), dimension: this.dimension() }));

  protected readonly chart = computed<{ labels: string[]; datasets: RjChartDataset[] }>(() => {
    const rows = (this.report.data()?.rows ?? []).slice(0, CHART_ROWS);
    return {
      labels: rows.map((row) => label(row)),
      datasets: [
        { label: 'Inscrits', data: rows.map((row) => row.signups), tone: 'primary' },
        { label: 'Payants', data: rows.map((row) => row.payers), tone: 'info' },
      ],
    };
  });

  protected readonly columns = computed<readonly RjTableColumn<AcquisitionRow>[]>(() => {
    const dimension = this.report.data()?.dimension ?? this.dimension();
    const columns: RjTableColumn<AcquisitionRow>[] = [
      { key: 'value', label: ACQUISITION_DIMENSION_LABELS[dimension], value: (row) => label(row), primary: true },
      { key: 'signups', label: 'Inscrits', value: (row) => row.signups, unit: 'count' },
      { key: 'verified', label: 'Vérifiés', value: (row) => row.verified, unit: 'count', hideOnMobile: true },
      { key: 'trials', label: 'Essais', value: (row) => row.trials, unit: 'count', hideOnMobile: true },
      { key: 'payers', label: 'Payants', value: (row) => row.payers, unit: 'count' },
      { key: 'rate', label: 'Conversion', value: (row) => row.conversionRate, unit: 'ratio' },
      { key: 'mrr', label: 'MRR', value: (row) => row.mrrCents, unit: 'cents' },
    ];
    if (dimension === 'source') columns.push({ key: 'ga4', label: 'Sessions GA4', value: (row) => row.ga4Sessions, unit: 'count', hideOnMobile: true });
    return columns;
  });

  constructor() {
    reloadOn(this.query, this.report, (query) => this.api.acquisition({ period: query.period }, query.dimension));
  }

  protected setDimension(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if ((ACQUISITION_DIMENSIONS as readonly string[]).includes(value)) this.dimension.set(value as AcquisitionDimension);
  }

  protected reload(): void {
    const query = this.query();
    void this.report.load(() => this.api.acquisition({ period: query.period }, query.dimension));
  }
}

function label(row: AcquisitionRow): string {
  return row.value ?? ACQUISITION_DIRECT_LABEL;
}
