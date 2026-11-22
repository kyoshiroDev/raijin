import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { GA4_DEVICE_LABELS, computeChange, type AdminPeriod, type AdminTraffic, type AdminTrafficData, type MetricUnit } from '@raijin/shared-contracts';
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
  RjServiceState,
  timeSeriesToChart,
  type RjChartDataset,
  type RjTableColumn,
} from '../../ui';
import { ADMIN_PAGE_PERIODS, RjAdminReportState, comparisonLabel, previousLabel, reloadOn } from '../shared/page-helpers';

type Row<K extends keyof AdminTrafficData> = AdminTrafficData[K] extends readonly (infer R)[] ? R : never;

interface Kpi {
  readonly label: string;
  readonly unit: MetricUnit;
  readonly value: number;
  readonly previous: number | null;
}

/**
 * Écran 2 — Trafic de la landing (API Google Analytics Data, cache 1 h) : visiteurs, sessions, engagement, part mobile,
 * pages, sources et canaux, appareils, pays, événements clés. « Non connecté » sans compte de service.
 */
@Component({
  selector: 'rj-admin-traffic-page',
  imports: [RjAdminPageHeader, RjPeriodSelect, RjRangeCaption, RjServiceState, RjKpiGrid, RjKpiCard, RjAdminPanel, RjChart, RjDataTable, RjAdminReportState],
  template: `
    <div class="flex flex-col gap-4 md:gap-6">
      <rj-admin-page-header [title]="screen.title" [description]="screen.description">
        <div rjHeaderMeta class="flex flex-wrap items-center gap-2 pt-1">
          @if (report.data(); as traffic) {
            <rj-range-caption [range]="traffic.range" />
            <rj-service-state service="ga4" [state]="traffic.service" variant="inline" />
          }
        </div>
        <rj-period-select [(period)]="period" [periods]="periods" />
      </rj-admin-page-header>

      <rj-admin-report-state [report]="report" [kpis]="6" (retry)="reload()">
        @if (report.data(); as traffic) {
          @if (traffic.data; as data) {
            <rj-kpi-grid>
              @for (kpi of kpis(); track kpi.label) {
                <rj-kpi-card [label]="kpi.label" [unit]="kpi.unit" [value]="kpi.value" [previous]="kpi.previous" [change]="change(kpi)" [comparisonLabel]="comparison()" source="ga4" />
              }
            </rj-kpi-grid>

            <rj-admin-panel title="Visiteurs et sessions" description="Par jour, avec la période précédente">
              @for (chart of series(); track chart.title) {
                <rj-chart type="line" [title]="chart.title" unit="count" [labels]="chart.labels" [datasets]="chart.datasets" />
              }
            </rj-admin-panel>

            <div class="grid gap-4 md:gap-6 xl:grid-cols-2">
              <rj-admin-panel title="Canaux" description="Part des sessions par canal GA4">
                <rj-chart type="doughnut" title="Sessions par canal" unit="count" categoryLabel="Canal" height="sm" [labels]="channels().labels" [datasets]="channels().datasets" />
              </rj-admin-panel>
              <rj-admin-panel title="Appareils" description="Part des sessions par type d’appareil">
                <rj-chart type="doughnut" title="Sessions par appareil" unit="count" categoryLabel="Appareil" height="sm" [labels]="devices().labels" [datasets]="devices().datasets" />
              </rj-admin-panel>
            </div>

            <rj-admin-panel title="Pages les plus vues">
              <rj-data-table caption="Pages les plus vues" [columns]="pageColumns" [rows]="data.topPages" />
            </rj-admin-panel>

            <div class="grid gap-4 md:gap-6 xl:grid-cols-2">
              <rj-admin-panel title="Sources" description="Source et support des sessions">
                <rj-data-table caption="Sources des sessions" [columns]="sourceColumns" [rows]="data.sources" />
              </rj-admin-panel>
              <rj-admin-panel title="Pays">
                <rj-data-table caption="Sessions par pays" [columns]="countryColumns" [rows]="data.countries" />
              </rj-admin-panel>
            </div>

            <rj-admin-panel title="Événements" description="Événements de la landing ; les événements clés comptent comme conversions dans GA4">
              <rj-data-table caption="Événements GA4" [columns]="eventColumns" [rows]="data.events" />
            </rj-admin-panel>
          } @else {
            <rj-service-state service="ga4" [state]="traffic.service" />
          }
        }
      </rj-admin-report-state>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminTrafficPage {
  private readonly api = inject(AdminApi);
  protected readonly screen = adminScreen('trafic');
  protected readonly periods = ADMIN_PAGE_PERIODS;
  protected readonly period = signal<AdminPeriod>('30d');
  protected readonly report = createAdminReport<AdminTraffic>();
  protected readonly comparison = computed(() => comparisonLabel(this.period()));

  protected readonly kpis = computed<Kpi[]>(() => {
    const data = this.report.data()?.data;
    if (!data) return [];
    const { totals, previousTotals: before } = data;
    return [
      { label: 'Visiteurs', unit: 'count', value: totals.activeUsers, previous: before?.activeUsers ?? null },
      { label: 'Nouveaux visiteurs', unit: 'count', value: totals.newUsers, previous: before?.newUsers ?? null },
      { label: 'Sessions', unit: 'count', value: totals.sessions, previous: before?.sessions ?? null },
      { label: 'Taux d’engagement', unit: 'ratio', value: totals.engagementRate, previous: before?.engagementRate ?? null },
      { label: 'Engagement moyen', unit: 'seconds', value: totals.averageEngagementSeconds, previous: before?.averageEngagementSeconds ?? null },
      { label: 'Part mobile', unit: 'ratio', value: totals.mobileShare, previous: before?.mobileShare ?? null },
    ];
  });

  protected readonly series = computed(() => {
    const data = this.report.data()?.data;
    if (!data) return [];
    const titles: Record<string, string> = { active_users: 'Visiteurs', sessions: 'Sessions' };
    return data.series.map((series) => {
      const title = titles[series.key] ?? series.key;
      return { title, ...timeSeriesToChart(series, { current: title, comparison: previousLabel(this.period()) }) };
    });
  });

  protected readonly channels = computed<{ labels: string[]; datasets: RjChartDataset[] }>(() => {
    const rows = this.report.data()?.data?.channels ?? [];
    return { labels: rows.map((row) => row.channel), datasets: [{ label: 'Sessions', data: rows.map((row) => row.sessions), tone: 'primary', tones: rows.map((_row, i) => (i === 0 ? 'primary' : i === 1 ? 'info' : 'muted')) }] };
  });

  protected readonly devices = computed<{ labels: string[]; datasets: RjChartDataset[] }>(() => {
    const rows = this.report.data()?.data?.devices ?? [];
    return {
      labels: rows.map((row) => GA4_DEVICE_LABELS[row.category]),
      datasets: [{ label: 'Sessions', data: rows.map((row) => row.sessions), tone: 'primary', tones: rows.map((row) => (row.category === 'mobile' ? 'primary' : row.category === 'desktop' ? 'info' : 'muted')) }],
    };
  });

  protected readonly pageColumns: readonly RjTableColumn<Row<'topPages'>>[] = [
    { key: 'path', label: 'Page', value: (row) => row.path, primary: true, mono: true },
    { key: 'title', label: 'Titre', value: (row) => row.title, hideOnMobile: true },
    { key: 'views', label: 'Vues', value: (row) => row.views, unit: 'count' },
    { key: 'users', label: 'Visiteurs', value: (row) => row.users, unit: 'count' },
  ];

  protected readonly sourceColumns: readonly RjTableColumn<Row<'sources'>>[] = [
    { key: 'source', label: 'Source', value: (row) => row.source, primary: true },
    { key: 'medium', label: 'Support', value: (row) => row.medium },
    { key: 'sessions', label: 'Sessions', value: (row) => row.sessions, unit: 'count' },
    { key: 'keyEvents', label: 'Événements clés', value: (row) => row.keyEvents, unit: 'count' },
  ];

  protected readonly countryColumns: readonly RjTableColumn<Row<'countries'>>[] = [
    { key: 'country', label: 'Pays', value: (row) => row.country, primary: true },
    { key: 'id', label: 'Code', value: (row) => row.countryId, mono: true },
    { key: 'sessions', label: 'Sessions', value: (row) => row.sessions, unit: 'count' },
  ];

  protected readonly eventColumns: readonly RjTableColumn<Row<'events'>>[] = [
    { key: 'name', label: 'Événement', value: (row) => row.name, primary: true, mono: true },
    { key: 'key', label: 'Type', value: (row) => (row.isKeyEvent ? 'Événement clé' : 'Standard') },
    { key: 'count', label: 'Nombre', value: (row) => row.count, unit: 'count' },
  ];

  constructor() {
    reloadOn(this.period, this.report, (period) => this.api.traffic({ period }));
  }

  protected reload(): void {
    void this.report.load(() => this.api.traffic({ period: this.period() }));
  }

  protected change(kpi: Kpi): number | null {
    return computeChange(kpi.value, kpi.previous);
  }
}
