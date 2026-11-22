import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TRIAL_REFUSAL_REASONS, type AdminTrials, type TrialCohort, type TrialRefusalReason } from '@raijin/shared-contracts';
import { AdminApi, createAdminReport } from '@raijin/web-data-access';
import { RjEmptyState } from '@raijin/web-ui';
import { adminScreen } from '../../shell/admin-screens';
import { RjAdminPageHeader, RjAdminPanel, RjChart, RjDataTable, RjKpiCard, RjKpiGrid, formatDay, formatMetric, type RjChartDataset, type RjTableColumn } from '../../ui';
import { RjAdminReportState } from '../shared/page-helpers';

const REFUSAL_LABELS: Readonly<Record<TrialRefusalReason, string>> = {
  email_already_used: 'E-mail ayant déjà eu un essai',
  disposable_domain: 'Adresse jetable',
  fingerprint_seen: 'Même appareil et même réseau',
};

/**
 * Écran 6 — Essais Pro : en cours, fin sous 48 h, conversion par cohorte de semaine (convertis / terminés), comptes
 * bloqués par l'anti-abus, raisons de non-conversion (aucune collecte en v1 : état vide explicite).
 */
@Component({
  selector: 'rj-admin-trials-page',
  imports: [RjAdminPageHeader, RjKpiGrid, RjKpiCard, RjAdminPanel, RjChart, RjDataTable, RjEmptyState, RjAdminReportState],
  template: `
    <div class="flex flex-col gap-4 md:gap-6">
      <rj-admin-page-header [title]="screen.title" [description]="screen.description" />

      <rj-admin-report-state [report]="report" [kpis]="4" (retry)="load()">
        @if (report.data(); as trials) {
          <rj-kpi-grid>
            <rj-kpi-card label="Essais en cours" [value]="trials.activeTrials" />
            <rj-kpi-card label="Fin dans les 48 h" [value]="trials.endingWithin48h" />
            <rj-kpi-card label="Conversion (26 semaines)" unit="ratio" [value]="trials.conversion.totals.conversionRate" [status]="trials.conversion.totals.conversionRate === null ? 'unavailable' : 'ok'" />
            <rj-kpi-card label="Comptes bloqués (anti-abus)" [value]="refusalTotal()" />
          </rj-kpi-grid>

          <rj-admin-panel title="Conversion par cohorte" description="Semaine de début d’essai (lundi, UTC) ; taux = convertis / essais terminés">
            <rj-chart type="bar" title="Taux de conversion par semaine" unit="ratio" categoryLabel="Semaine" [labels]="chart().labels" [datasets]="chart().datasets" />
            <rj-data-table caption="Cohortes d’essai" [columns]="columns" [rows]="trials.conversion.cohorts" emptyText="Aucun essai sur les 26 dernières semaines." />
          </rj-admin-panel>

          <div class="grid gap-4 md:gap-6 xl:grid-cols-2">
            <rj-admin-panel title="Refus de l’anti-abus" description="Essais refusés à la vérification de l’e-mail, par motif">
              <ul class="flex flex-col divide-y divide-line">
                @for (reason of reasons; track reason) {
                  <li class="flex min-h-11 items-center justify-between gap-3 py-2">
                    <span class="text-body text-ink">{{ refusalLabels[reason] }}</span>
                    <span class="tabular text-body font-semibold text-ink">{{ count(trials.conversion.refusals[reason]) }}</span>
                  </li>
                }
              </ul>
            </rj-admin-panel>
            <rj-admin-panel title="Raisons de non-conversion">
              @if (trials.nonConversionReasons.length === 0) {
                <rj-empty-state title="Aucune raison collectée" description="Raijin ne demande pas encore pourquoi un essai ne se transforme pas : la question arrivera avec l’écran de fin d’essai." />
              } @else {
                <ul class="flex flex-col divide-y divide-line">
                  @for (item of trials.nonConversionReasons; track item.reason) {
                    <li class="flex min-h-11 items-center justify-between gap-3 py-2">
                      <span class="min-w-0 truncate text-body text-ink" [attr.title]="item.reason">{{ item.reason }}</span>
                      <span class="tabular font-semibold text-ink">{{ count(item.count) }}</span>
                    </li>
                  }
                </ul>
              }
            </rj-admin-panel>
          </div>
        }
      </rj-admin-report-state>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminTrialsPage {
  private readonly api = inject(AdminApi);
  protected readonly screen = adminScreen('essais');
  protected readonly report = createAdminReport<AdminTrials>();
  protected readonly reasons = TRIAL_REFUSAL_REASONS;
  protected readonly refusalLabels = REFUSAL_LABELS;
  protected readonly refusalTotal = computed(() => {
    const refusals = this.report.data()?.conversion.refusals;
    return refusals ? TRIAL_REFUSAL_REASONS.reduce((sum, reason) => sum + refusals[reason], 0) : null;
  });
  protected readonly chart = computed<{ labels: string[]; datasets: RjChartDataset[] }>(() => {
    // Plus ancienne à gauche : lecture chronologique.
    const cohorts = [...(this.report.data()?.conversion.cohorts ?? [])].reverse();
    return { labels: cohorts.map((cohort) => formatDay(cohort.weekStart)), datasets: [{ label: 'Conversion', data: cohorts.map((cohort) => cohort.conversionRate), tone: 'primary' }] };
  });
  protected readonly columns: readonly RjTableColumn<TrialCohort>[] = [
    { key: 'week', label: 'Semaine du', value: (row) => row.weekStart, format: (row) => formatDay(row.weekStart), primary: true },
    { key: 'started', label: 'Commencés', value: (row) => row.started, unit: 'count' },
    { key: 'active', label: 'En cours', value: (row) => row.active, unit: 'count' },
    { key: 'converted', label: 'Convertis', value: (row) => row.converted, unit: 'count' },
    { key: 'expired', label: 'Expirés', value: (row) => row.expired, unit: 'count' },
    { key: 'rate', label: 'Conversion', value: (row) => row.conversionRate, unit: 'ratio' },
  ];

  constructor() {
    this.load();
  }

  protected load(): void {
    void this.report.load(() => this.api.trials());
  }

  protected count(value: number): string {
    return formatMetric(value, 'count');
  }
}
