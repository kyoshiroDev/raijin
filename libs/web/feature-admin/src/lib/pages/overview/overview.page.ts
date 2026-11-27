import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FUNNEL_STEP_LABELS, type AdminOverview, type AdminPeriod } from '@raijin/shared-contracts';
import { AdminApi, createAdminReport } from '@raijin/web-data-access';
import { adminScreen } from '../../shell/admin-screens';
import {
  NO_VALUE,
  RjAdminPageHeader,
  RjAdminPanel,
  RjChart,
  RjKpiCard,
  RjKpiGrid,
  RjPeriodSelect,
  RjRangeCaption,
  RjServiceState,
  formatLongDay,
  formatMetric,
  timeSeriesToChart,
  type RjChartDataset,
} from '../../ui';
import { ADMIN_PAGE_PERIODS, RjAdminReportState, comparisonLabel, previousLabel, reloadOn } from '../shared/page-helpers';

/**
 * Écran 1 — Vue d'ensemble : 10 KPI (grille de 2 sur mobile) avec variation, tendance des inscriptions et des
 * analyses (période précédente en `info`), entonnoir visites (GA4) → analyse démo → inscription → vérifié → essai → Pro.
 */
@Component({
  selector: 'rj-admin-overview-page',
  imports: [RjAdminPageHeader, RjPeriodSelect, RjRangeCaption, RjServiceState, RjKpiGrid, RjKpiCard, RjAdminPanel, RjChart, RjAdminReportState],
  template: `
    <div class="flex flex-col gap-4 md:gap-6">
      <rj-admin-page-header [title]="screen.title" [description]="screen.description">
        <div rjHeaderMeta class="flex flex-wrap items-center gap-2 pt-1">
          @if (report.data(); as data) {
            <rj-range-caption [range]="data.range" />
            <rj-service-state service="ga4" [state]="data.ga4" variant="inline" />
          }
        </div>
        <rj-period-select [(period)]="period" [periods]="periods" />
      </rj-admin-page-header>

      <rj-admin-report-state [report]="report" [kpis]="10" (retry)="reload()">
        @if (report.data(); as data) {
          @if (data.aggregatedThrough === null) {
            <p class="text-body-sm text-ink-muted">Les agrégats nocturnes n’ont pas encore tourné : seuls les derniers jours sont calculés en direct.</p>
          } @else {
            <p class="text-body-sm text-ink-muted">Agrégats calculés jusqu’au {{ day(data.aggregatedThrough) }} ; aujourd’hui en direct.</p>
          }
          <rj-kpi-grid [wide]="true">
            @for (kpi of data.kpis; track kpi.key) {
              <rj-kpi-card [kpi]="kpi" [comparisonLabel]="comparison()" />
            }
          </rj-kpi-grid>

          <div class="grid gap-4 md:gap-6 xl:grid-cols-2">
            @for (chart of trends(); track chart.title) {
              <rj-admin-panel [title]="chart.title" description="Par jour, avec la période précédente">
                <rj-chart type="line" [title]="chart.title" unit="count" [labels]="chart.labels" [datasets]="chart.datasets" />
              </rj-admin-panel>
            }
          </div>

          <rj-admin-panel title="Entonnoir" description="De la visite de la landing à l’abonnement Pro, sur la période">
            @if (data.ga4.status !== 'connected') {
              <rj-service-state service="ga4" [state]="data.ga4" />
            }
            <rj-chart
              type="bar"
              title="Entonnoir de conversion"
              unit="count"
              [horizontal]="true"
              height="sm"
              categoryLabel="Étape"
              [legend]="false"
              [labels]="funnel().labels"
              [datasets]="funnel().datasets"
            />
            <ol class="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
              @for (step of data.funnel; track step.key; let i = $index) {
                <li class="flex h-full min-w-0 flex-col gap-0.5 rounded-md border border-line bg-surface-raised p-3">
                  <span class="text-label text-ink-muted">{{ i + 1 }}. {{ labels[step.key] }}</span>
                  <span class="tabular text-h3 font-semibold text-ink">{{ count(step.value) }}</span>
                  <span class="mt-auto text-label text-ink-muted">
                    @if (step.rateFromPrevious !== null && step.exceedsPrevious) {
                      <span class="tabular">{{ ratio(step.rateFromPrevious) }}</span> (plafonné)<span aria-hidden="true">*</span>
                    } @else if (step.rateFromPrevious !== null) {
                      <span class="tabular">{{ ratio(step.rateFromPrevious) }}</span> de l’étape précédente
                    } @else if (step.status === 'not_connected') {
                      Non connecté
                    } @else {
                      {{ step.source === 'ga4' ? 'Google Analytics' : 'Données internes' }}
                    }
                  </span>
                </li>
              }
            </ol>
            @if (funnelExceeds()) {
              <p class="text-body-sm text-ink-muted" data-testid="funnel-cap-note">
                <span aria-hidden="true">* </span>Plafonné à 100 % : l’étape dépasse la précédente, mesurée par une autre source (visites Google Analytics
                comptées seulement après consentement, inscriptions sans analyse démo).
              </p>
            }
          </rj-admin-panel>
        }
      </rj-admin-report-state>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminOverviewPage {
  private readonly api = inject(AdminApi);
  protected readonly screen = adminScreen('');
  protected readonly periods = ADMIN_PAGE_PERIODS;
  protected readonly labels = FUNNEL_STEP_LABELS;
  protected readonly period = signal<AdminPeriod>('7d');
  protected readonly report = createAdminReport<AdminOverview>();
  protected readonly funnelExceeds = computed(() => (this.report.data()?.funnel ?? []).some((step) => step.exceedsPrevious));
  protected readonly comparison = computed(() => comparisonLabel(this.period()));
  protected readonly day = formatLongDay;

  protected readonly trends = computed(() => {
    const data = this.report.data();
    if (!data) return [];
    const titles: Record<string, string> = { signups: 'Inscriptions', analyses: 'Analyses' };
    return data.trend.map((series) => {
      const title = titles[series.key] ?? series.key;
      return { title, ...timeSeriesToChart(series, { current: title, comparison: previousLabel(this.period()) }) };
    });
  });

  protected readonly funnel = computed<{ labels: string[]; datasets: RjChartDataset[] }>(() => {
    const steps = this.report.data()?.funnel ?? [];
    return {
      labels: steps.map((step) => FUNNEL_STEP_LABELS[step.key]),
      datasets: [{ label: 'Personnes', data: steps.map((step) => step.value), tone: 'primary' }],
    };
  });

  constructor() {
    reloadOn(this.period, this.report, (period) => this.api.overview({ period }));
  }

  protected reload(): void {
    void this.report.load(() => this.api.overview({ period: this.period() }));
  }

  protected count(value: number | null): string {
    return value === null ? NO_VALUE : formatMetric(value, 'count');
  }

  protected ratio(value: number): string {
    return formatMetric(value, 'ratio');
  }
}
