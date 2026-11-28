import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { type AdminPeriod, type GoogleServiceState } from '@raijin/shared-contracts';
import { RjChart } from '../chart/chart';
import { timeSeriesToChart, type RjChartDataset } from '../chart/chart-config';
import { RjDataTable, type RjTableColumn } from '../data-table';
import { RjAdminFilters } from '../filters';
import { RjKpiCard } from '../kpi-card';
import { RjAdminPageHeader, RjAdminPanel, RjKpiGrid } from '../layout';
import { RjPeriodSelect, RjRangeCaption } from '../period-select';
import { RjDataLagNotice, RjServiceState } from '../service-state';
import { DEMO_RANGE, DEMO_TOP_PAGES, demoKpis, demoSeries, type DemoPageRow } from './admin-demo-data';

const DAYS: Readonly<Record<AdminPeriod, number>> = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

/**
 * Démonstration des composants admin avec des données fictives (développement seulement : `/admin/demo` dans
 * la coque, `/_design/admin`). Sert de référence visuelle et de base aux captures.
 */
@Component({
  selector: 'rj-admin-demo-page',
  imports: [
    RjChart,
    RjDataTable,
    RjAdminFilters,
    RjKpiCard,
    RjAdminPageHeader,
    RjAdminPanel,
    RjKpiGrid,
    RjPeriodSelect,
    RjRangeCaption,
    RjDataLagNotice,
    RjServiceState,
  ],
  template: `
    <div class="flex flex-col gap-6 md:gap-8">
      <rj-admin-page-header title="Composants admin" description="Données fictives : KPI, graphiques, tableaux et états des services.">
        <rj-range-caption rjHeaderMeta [range]="range" class="mt-1" />
        <rj-period-select [(period)]="period" />
        <rj-admin-filters [activeCount]="channel() === 'all' ? 0 : 1" description="Affiner les données affichées.">
          <label class="flex min-w-48 flex-col gap-1.5 text-body-sm font-medium text-ink">
            Canal
            <select
              class="min-h-11 rounded-md border border-line-strong bg-surface-raised px-3 text-input text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              [value]="channel()"
              (change)="channel.set($any($event.target).value)"
            >
              <option value="all">Tous les canaux</option>
              <option value="organic">Recherche naturelle</option>
              <option value="social">Réseaux sociaux</option>
            </select>
          </label>
        </rj-admin-filters>
      </rj-admin-page-header>

      <rj-kpi-grid [wide]="true">
        @for (kpi of kpis; track kpi.key) {
          <rj-kpi-card [kpi]="kpi" />
        }
      </rj-kpi-grid>

      <div class="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-3">
        <rj-admin-panel class="xl:col-span-2" title="Inscriptions" description="Par jour, comparées à la période précédente.">
          <rj-chart type="line" title="Inscriptions par jour" [labels]="trend().labels" [datasets]="trend().datasets" height="lg" />
        </rj-admin-panel>
        <rj-admin-panel title="Verdicts des analyses" description="Répartition sur la période.">
          <rj-chart type="doughnut" title="Répartition des verdicts" categoryLabel="Verdict" [labels]="verdictLabels" [datasets]="verdicts" height="md" />
        </rj-admin-panel>
      </div>

      <div class="grid grid-cols-1 gap-4 md:gap-6 xl:grid-cols-2">
        <rj-admin-panel title="Entonnoir" description="De la visite à l’abonnement Pro.">
          <rj-chart type="bar" [horizontal]="true" title="Entonnoir de conversion" categoryLabel="Étape" [labels]="funnelLabels" [datasets]="funnel" height="md" />
        </rj-admin-panel>
        <rj-admin-panel title="Google Analytics 4">
          <rj-service-state rjPanelActions service="ga4" variant="inline" [state]="simulated" />
          <rj-service-state service="ga4" [state]="notConnected" />
          <rj-service-state service="search_console" [state]="error" />
          <rj-data-lag-notice dataThrough="2026-11-19" [lagDays]="3" />
        </rj-admin-panel>
      </div>

      <rj-admin-panel title="Pages les plus vues" description="Sur la période, d’après GA4.">
        <rj-data-table caption="Pages les plus vues" [columns]="columns" [rows]="pages" [trackBy]="byPath" />
      </rj-admin-panel>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminDemoPage {
  protected readonly period = signal<AdminPeriod>('30d');
  protected readonly channel = signal('all');
  protected readonly range = DEMO_RANGE;
  protected readonly kpis = demoKpis();
  protected readonly trend = computed(() =>
    timeSeriesToChart(demoSeries('signups', DAYS[this.period()], 22, 6, true), { current: 'Inscriptions', comparison: 'Période précédente' }),
  );

  protected readonly verdictLabels = ['Sain', 'Prudence', 'Danger'];
  protected readonly verdicts: RjChartDataset[] = [{ label: 'Analyses', data: [11_240, 8_310, 5_266], tone: 'primary', tones: ['safe', 'warn', 'danger'] }];
  protected readonly funnelLabels = ['Visites', 'Analyse démo', 'Inscription', 'E-mail vérifié', 'Essai', 'Pro'];
  protected readonly funnel: RjChartDataset[] = [{ label: 'Personnes', data: [18_430, 4_120, 642, 519, 214, 39], tone: 'primary' }];

  protected readonly simulated: GoogleServiceState = {
    status: 'connected',
    fetchedAt: '2026-11-22T13:02:00.000Z',
    cachedUntil: '2026-11-22T14:02:00.000Z',
    simulated: true,
  };
  protected readonly notConnected: GoogleServiceState = { status: 'not_connected' };
  protected readonly error: GoogleServiceState = { status: 'error', error: 'permission_denied' };

  protected readonly pages = DEMO_TOP_PAGES;
  protected readonly byPath = (row: DemoPageRow) => row.path;
  protected readonly columns: RjTableColumn<DemoPageRow>[] = [
    { key: 'path', label: 'Page', value: (row) => row.path, primary: true, mono: true },
    { key: 'title', label: 'Titre', value: (row) => row.title, hideOnMobile: true },
    { key: 'views', label: 'Vues', value: (row) => row.views, unit: 'count' },
    { key: 'users', label: 'Visiteurs', value: (row) => row.users, unit: 'count' },
    { key: 'engagement', label: 'Engagement', value: (row) => row.engagement, unit: 'ratio' },
  ];
}
