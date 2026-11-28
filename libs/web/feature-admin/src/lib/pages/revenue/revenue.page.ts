import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ACQUISITION_DIRECT_LABEL, computeChange, type AdminPeriod, type AdminRevenue } from '@raijin/shared-contracts';
import { AdminApi, createAdminReport } from '@raijin/web-data-access';
import { adminScreen } from '../../shell/admin-screens';
import { RjAdminAlert } from '../../ui/alert';
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

type SourceRow = AdminRevenue['revenueBySource'][number];

/**
 * Écran 5 — Revenus (table Subscription et événements de facturation, sans appel à Stripe) : MRR et son évolution,
 * abonnés actifs, nouveaux, résiliations, paiements échoués, churn, mensuel / annuel, revenu par source.
 */
@Component({
  selector: 'rj-admin-revenue-page',
  imports: [RjAdminPageHeader, RjPeriodSelect, RjRangeCaption, RjAdminAlert, RjKpiGrid, RjKpiCard, RjAdminPanel, RjChart, RjDataTable, RjAdminReportState],
  template: `
    <div class="flex flex-col gap-4 md:gap-6">
      <rj-admin-page-header [title]="screen.title" [description]="screen.description">
        <div rjHeaderMeta class="pt-1">
          @if (report.data(); as revenue) {
            <rj-range-caption [range]="revenue.range" />
          }
        </div>
        <rj-period-select [(period)]="period" [periods]="periods" />
      </rj-admin-page-header>

      <rj-admin-report-state [report]="report" [kpis]="6" (retry)="reload()">
        @if (report.data(); as revenue) {
          @if (revenue.mode !== 'stripe') {
            <rj-admin-alert tone="info">
              {{ revenue.mode === 'simulation' ? 'Paiement en mode simulation : ces revenus viennent d’abonnements simulés, pas de Stripe.' : 'Stripe n’est pas configuré : aucun paiement réel n’est possible.' }}
            </rj-admin-alert>
          }
          <rj-kpi-grid>
            <rj-kpi-card label="MRR" unit="cents" [currency]="revenue.currency" [value]="revenue.mrrCents" [previous]="revenue.mrrPreviousCents" [change]="mrrChange()" [comparisonLabel]="comparison()" />
            <rj-kpi-card label="Abonnés actifs" [value]="revenue.activeSubscribers" />
            <rj-kpi-card label="Nouveaux abonnés" [value]="revenue.newSubscribers" />
            <rj-kpi-card label="Résiliations" [value]="revenue.cancellations" [higherIsBetter]="false" />
            <rj-kpi-card label="Paiements échoués" [value]="revenue.failedPayments" [higherIsBetter]="false" />
            <rj-kpi-card label="Churn" unit="ratio" [value]="revenue.churnRate" [status]="revenue.churnRate === null ? 'unavailable' : 'ok'" [higherIsBetter]="false" />
          </rj-kpi-grid>

          <rj-admin-panel title="MRR" description="Revenu mensuel récurrent de fin de journée, avec la période précédente">
            <rj-chart type="line" title="MRR par jour" unit="cents" [currency]="revenue.currency" [labels]="mrr().labels" [datasets]="mrr().datasets" />
          </rj-admin-panel>

          <div class="grid gap-4 md:gap-6 xl:grid-cols-2">
            <rj-admin-panel title="Mensuel ou annuel" description="Abonnés actifs par formule">
              <rj-chart type="doughnut" title="Répartition des formules" unit="count" categoryLabel="Formule" height="sm" [labels]="split().labels" [datasets]="split().datasets" />
            </rj-admin-panel>
            <rj-admin-panel title="Revenu par source" description="MRR actuel par source d’acquisition (UTM)">
              <rj-data-table caption="Revenu par source" [columns]="columns" [rows]="revenue.revenueBySource" [currency]="revenue.currency" emptyText="Aucun abonné actif." />
            </rj-admin-panel>
          </div>
        }
      </rj-admin-report-state>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminRevenuePage {
  private readonly api = inject(AdminApi);
  protected readonly screen = adminScreen('revenus');
  protected readonly periods = ADMIN_PAGE_PERIODS;
  protected readonly period = signal<AdminPeriod>('30d');
  protected readonly report = createAdminReport<AdminRevenue>();
  protected readonly comparison = computed(() => comparisonLabel(this.period()));
  protected readonly mrrChange = computed(() => {
    const data = this.report.data();
    return data ? computeChange(data.mrrCents, data.mrrPreviousCents) : null;
  });
  protected readonly mrr = computed(() => {
    const data = this.report.data();
    return data ? timeSeriesToChart(data.mrrSeries, { current: 'MRR', comparison: previousLabel(this.period()) }) : { labels: [], datasets: [] };
  });
  protected readonly split = computed<{ labels: string[]; datasets: RjChartDataset[] }>(() => {
    const data = this.report.data();
    return {
      labels: ['Mensuel', 'Annuel'],
      datasets: [{ label: 'Abonnés', data: [data?.intervalSplit.month ?? 0, data?.intervalSplit.year ?? 0], tone: 'primary', tones: ['primary', 'info'] }],
    };
  });
  protected readonly columns: readonly RjTableColumn<SourceRow>[] = [
    { key: 'source', label: 'Source', value: (row) => row.source ?? ACQUISITION_DIRECT_LABEL, primary: true },
    { key: 'payers', label: 'Payants', value: (row) => row.payers, unit: 'count' },
    { key: 'mrr', label: 'MRR', value: (row) => row.mrrCents, unit: 'cents' },
  ];

  constructor() {
    reloadOn(this.period, this.report, (period) => this.api.revenue({ period }));
  }

  protected reload(): void {
    void this.report.load(() => this.api.revenue({ period: this.period() }));
  }
}
