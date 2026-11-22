import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  ADMIN_ALERT_KIND_LABELS,
  ADMIN_JOB_LABELS,
  QUOTA_SERVICE_LABELS,
  quotaServiceSchema,
  type AdminAlert,
  type AdminHealth,
  type AdminJobHealth,
  type AdminQuotaUsage,
} from '@raijin/shared-contracts';
import { AdminApi, createAdminReport } from '@raijin/web-data-access';
import { RjButton, RjIcon, type RjIconName } from '@raijin/web-ui';
import { adminScreen } from '../../shell/admin-screens';
import { RjAdminAlert } from '../../ui/alert';
import { NO_VALUE, RjAdminPageHeader, RjAdminPanel, RjDataTable, RjKpiCard, RjKpiGrid, formatMetric, formatTime, type RjTableColumn } from '../../ui';
import { RjAdminReportState } from '../shared/page-helpers';

/** Libellés des services de l'état de configuration (clé brute pour un service inconnu). */
const SERVICE_LABELS: Readonly<Record<string, string>> = {
  database: 'Base de données',
  redis: 'Redis',
  helius: 'Helius',
  resend: 'Resend (e-mails)',
  smtp: 'SMTP (e-mails, dev)',
  stripe: 'Stripe',
  vapid: 'Clés VAPID (push)',
  push: 'Notifications push',
  ga4: 'GA4 (landing)',
  ga4_data_api: 'Google Analytics Data API',
  search_console: 'Google Search Console',
  google_service_account: 'Compte de service Google',
  totp_key: 'Clé de chiffrement 2FA',
  sentry: 'Sentry',
};

const QUOTA_BAR: Readonly<Record<AdminQuotaUsage['level'], string>> = { ok: 'bg-safe', warning: 'bg-warn', critical: 'bg-danger' };
const QUOTA_TEXT: Readonly<Record<AdminQuotaUsage['level'], { icon: RjIconName; label: string; tone: string }>> = {
  ok: { icon: 'safe', label: 'Normal', tone: 'text-safe' },
  warning: { icon: 'warn', label: 'Au-delà de 80 %', tone: 'text-warn' },
  critical: { icon: 'danger', label: 'Limite atteinte', tone: 'text-danger' },
};

/**
 * Écran 9 — Santé technique : alertes admin, jobs (dernière exécution, durée, échecs consécutifs, code d'erreur),
 * consommation et limites des API externes, taux d'erreur de l'API, e-mails, push, taille de la base, services
 * configurés ou non (jamais de valeur). Lecture seule, rafraîchissable.
 */
@Component({
  selector: 'rj-admin-health-page',
  imports: [RjAdminPageHeader, RjAdminAlert, RjKpiGrid, RjKpiCard, RjAdminPanel, RjDataTable, RjButton, RjIcon, RjAdminReportState],
  template: `
    <div class="flex flex-col gap-4 md:gap-6">
      <rj-admin-page-header [title]="screen.title" [description]="screen.description">
        <div rjHeaderMeta class="pt-1 text-body-sm text-ink-muted">
          @if (report.data(); as health) {
            Relevé à {{ time(health.generatedAt) }}
          }
        </div>
        <button type="button" rjButton="secondary" icon="retry" [loading]="report.status() === 'loading'" (click)="load()">Actualiser</button>
      </rj-admin-page-header>

      <rj-admin-report-state [report]="report" [kpis]="4" (retry)="load()">
        @if (report.data(); as health) {
          @for (alert of openAlerts(); track alert.id) {
            <rj-admin-alert [tone]="alert.level === 'critical' ? 'danger' : 'warn'">
              <p class="font-semibold">{{ kindLabels[alert.kind] }} : {{ subject(alert) }}</p>
              <p class="text-body-sm text-ink-muted">{{ alertDetails(alert) }}</p>
            </rj-admin-alert>
          }

          <rj-kpi-grid>
            <rj-kpi-card label="Requêtes API (24 h)" [value]="health.api.requests" />
            <rj-kpi-card label="Taux d’erreur 5xx" unit="ratio" [value]="health.api.errorRate" [status]="health.api.errorRate === null ? 'unavailable' : 'ok'" />
            <rj-kpi-card [label]="'E-mails envoyés (24 h, ' + health.emails.provider + ')'" [value]="health.emails.sent24h" />
            <rj-kpi-card label="E-mails en échec (24 h)" [value]="health.emails.failed24h" />
            <rj-kpi-card label="Abonnements push actifs" [value]="health.push.activeSubscriptions" />
            <rj-kpi-card label="Taille de la base" unit="bytes" [value]="health.database.sizeBytes" [status]="health.database.sizeBytes === null ? 'unavailable' : 'ok'" />
          </rj-kpi-grid>

          <rj-admin-panel title="Jobs" description="Dernière exécution, durée et échecs consécutifs (alerte à 3)">
            <rj-data-table caption="État des jobs" [columns]="jobColumns" [rows]="health.jobs" [trackBy]="byName" />
          </rj-admin-panel>

          <div class="grid gap-4 md:gap-6 xl:grid-cols-2">
            <rj-admin-panel title="API externes" description="Consommation du jour (UTC) et limite connue">
              <ul class="flex flex-col gap-3">
                @for (quota of health.quotas; track quota.service) {
                  <li class="flex flex-col gap-1.5">
                    <div class="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span class="text-body text-ink">{{ quotaLabels[quota.service] }}</span>
                      <span class="tabular text-body-sm text-ink">{{ usage(quota) }}</span>
                    </div>
                    @if (quota.ratio !== null) {
                      <div class="h-2 overflow-hidden rounded-full bg-surface-raised" role="progressbar" [attr.aria-label]="quotaLabels[quota.service]" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="percent(quota.ratio)">
                        <div [class]="'h-full rounded-full ' + bar[quota.level]" [style.width.%]="percent(quota.ratio)"></div>
                      </div>
                      <span [class]="'inline-flex items-center gap-1 text-label font-semibold ' + level[quota.level].tone">
                        <rj-icon [name]="level[quota.level].icon" [size]="16" />{{ level[quota.level].label }}
                      </span>
                    } @else {
                      <span class="text-label text-ink-muted">Sans plafond journalier connu : appels comptés seulement.</span>
                    }
                  </li>
                } @empty {
                  <li class="text-body-sm text-ink-muted">Compteurs indisponibles pour le moment.</li>
                }
              </ul>
            </rj-admin-panel>

            <rj-admin-panel title="Services" description="Configurés ou non (aucune valeur n’est jamais affichée)">
              <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                @for (service of services(); track service.key) {
                  <li class="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 py-2">
                    <rj-icon [name]="service.configured ? 'circleCheck' : 'unavailable'" [size]="16" [class]="service.configured ? 'text-safe' : 'text-ink-muted'" />
                    <span class="min-w-0 flex-1 truncate text-body-sm text-ink" [attr.title]="service.label">{{ service.label }}</span>
                    <span class="text-label text-ink-muted">{{ service.configured ? 'Configuré' : 'Non configuré' }}</span>
                  </li>
                }
              </ul>
            </rj-admin-panel>
          </div>

          @if (resolvedAlerts().length > 0) {
            <rj-admin-panel title="Alertes récentes" description="Incidents résolus (job revenu à la normale, nouveau jour UTC)">
              <rj-data-table caption="Alertes résolues" [columns]="alertColumns" [rows]="resolvedAlerts()" [trackBy]="byId" />
            </rj-admin-panel>
          }
        }
      </rj-admin-report-state>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminHealthPage {
  private readonly api = inject(AdminApi);
  protected readonly screen = adminScreen('sante');
  protected readonly report = createAdminReport<AdminHealth>();
  protected readonly kindLabels = ADMIN_ALERT_KIND_LABELS;
  protected readonly quotaLabels = QUOTA_SERVICE_LABELS;
  protected readonly bar = QUOTA_BAR;
  protected readonly level = QUOTA_TEXT;
  protected readonly time = formatTime;
  protected readonly byName = (row: AdminJobHealth) => row.name;
  protected readonly byId = (row: AdminAlert) => row.id;

  protected readonly openAlerts = computed(() => (this.report.data()?.alerts ?? []).filter((alert) => alert.resolvedAt === null));
  protected readonly resolvedAlerts = computed(() => (this.report.data()?.alerts ?? []).filter((alert) => alert.resolvedAt !== null));
  protected readonly services = computed(() =>
    Object.entries(this.report.data()?.services ?? {})
      .map(([key, state]) => ({ key, label: SERVICE_LABELS[key] ?? key, configured: state === 'configured' }))
      .sort((a, b) => Number(a.configured) - Number(b.configured) || a.label.localeCompare(b.label, 'fr')),
  );

  protected readonly jobColumns: readonly RjTableColumn<AdminJobHealth>[] = [
    { key: 'name', label: 'Job', value: (row) => ADMIN_JOB_LABELS[row.name] ?? row.name, primary: true },
    { key: 'status', label: 'Statut', value: (row) => jobStatus(row) },
    { key: 'last', label: 'Dernière exécution', value: (row) => (row.lastRunAt ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(row.lastRunAt)) : NO_VALUE) },
    { key: 'duration', label: 'Durée', value: (row) => row.lastDurationMs, unit: 'ms' },
    { key: 'failures', label: 'Échecs de suite', value: (row) => row.consecutiveFailures, unit: 'count' },
    { key: 'error', label: 'Code', value: (row) => row.lastErrorCode, mono: true, hideOnMobile: true },
  ];

  protected readonly alertColumns: readonly RjTableColumn<AdminAlert>[] = [
    { key: 'subject', label: 'Sujet', value: (row) => this.subject(row), primary: true },
    { key: 'kind', label: 'Type', value: (row) => ADMIN_ALERT_KIND_LABELS[row.kind] },
    { key: 'created', label: 'Ouverte', value: (row) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(row.createdAt)) },
    { key: 'resolved', label: 'Résolue', value: (row) => (row.resolvedAt ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(row.resolvedAt)) : NO_VALUE) },
  ];

  constructor() {
    this.load();
  }

  protected load(): void {
    void this.report.load(() => this.api.health());
  }

  protected subject(alert: AdminAlert): string {
    if (alert.kind === 'quota_threshold') {
      const service = quotaServiceSchema.safeParse(alert.subject);
      return service.success ? QUOTA_SERVICE_LABELS[service.data] : alert.subject;
    }
    return ADMIN_JOB_LABELS[alert.subject] ?? alert.subject;
  }

  protected alertDetails(alert: AdminAlert): string {
    const d = alert.details;
    const parts: string[] = [];
    if (d.consecutiveFailures !== undefined) parts.push(`${d.consecutiveFailures} échecs de suite`);
    if (d.lastErrorCode) parts.push(`code ${d.lastErrorCode}`);
    if (d.used !== undefined && d.limit !== undefined) parts.push(`${formatMetric(d.used, 'count')} sur ${formatMetric(d.limit, 'count')}`);
    parts.push(alert.notifiedAt ? `prévenu à ${formatTime(alert.notifiedAt)}` : 'envoi en attente');
    return parts.join(' · ');
  }

  protected usage(quota: AdminQuotaUsage): string {
    const used = formatMetric(quota.used, 'count');
    return quota.limit === null ? used : `${used} / ${formatMetric(quota.limit, 'count')}`;
  }

  protected percent(ratio: number): number {
    return Math.min(100, Math.round(ratio * 100));
  }
}

function jobStatus(job: AdminJobHealth): string {
  switch (job.lastStatus) {
    case 'success':
      return 'Réussi';
    case 'failed':
      return 'En échec';
    case 'running':
      return 'En cours';
    default:
      return 'Jamais exécuté';
  }
}
