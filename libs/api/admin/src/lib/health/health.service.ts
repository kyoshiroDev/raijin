import { Inject, Injectable, Logger } from '@nestjs/common';
import { AnalyticsService } from '@raijin/api-analytics';
import { BillingProvider } from '@raijin/api-billing';
import { APP_CONFIG, errorCode, type AppConfig } from '@raijin/api-core';
import { PushSender } from '@raijin/api-notifications';
import { PrismaService } from '@raijin/api-prisma';
import { UpstreamUsageReader } from '@raijin/api-solana';
import { adminAlertSchema, adminHealthSchema, type AdminAlert, type AdminHealth, type AdminJobHealth, type AdminQuotaUsage } from '@raijin/shared-contracts';
import { addDays, utcDay } from '../common/range';
import { DailyCounters, type DailyCounterValues } from '../metrics/daily-counters';
import { databaseSize } from '../metrics/metrics-calculator';
import { JobHealthReader, type JobState } from './job-health';
import { quotasWithBudgets } from './quotas';

/** `camelCase` → `snake_case` (clés de `services` du contrat). */
export function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Fenêtre glissante de 24 h estimée avec les compteurs journaliers : jour en cours + part restante de la veille
 * (au prorata de l'heure UTC). Aucun compteur horaire n'est stocké.
 */
export function last24h(today: DailyCounterValues | null, yesterday: DailyCounterValues | null, now: Date, field: keyof DailyCounterValues): number {
  const elapsed = (now.getTime() - Date.parse(`${utcDay(now)}T00:00:00Z`)) / 86_400_000;
  return Math.round((today?.[field] ?? 0) + (yesterday?.[field] ?? 0) * Math.max(0, 1 - elapsed));
}

/**
 * La fenêtre de 24 h est-elle reconstituée (`api.estimated`) ? Exacte seulement si la veille n'y contribue pas : minuit
 * UTC pile, ou veille relue sans aucune requête. Veille illisible (stockage indisponible) : estimée (valeur incomplète).
 */
export function last24hEstimated(yesterday: DailyCounterValues | null, now: Date): boolean {
  const elapsed = (now.getTime() - Date.parse(`${utcDay(now)}T00:00:00Z`)) / 86_400_000;
  if (elapsed <= 0) return false;
  return yesterday === null || yesterday.api_requests > 0 || yesterday.api_errors_5xx > 0;
}

/** État interne d'un job → contrat (sans l'identifiant du premier échec ni la date du dernier succès). */
export function toJobHealth(state: JobState): AdminJobHealth {
  const { name, lastRunAt, lastStatus, lastDurationMs, consecutiveFailures, lastErrorCode, nextRunAt } = state;
  return { name, lastRunAt, lastStatus, lastDurationMs, consecutiveFailures, lastErrorCode, nextRunAt };
}

/** Ligne `AdminAlert` → contrat (une ligne non conforme est ignorée, jamais renvoyée telle quelle). */
export function toAdminAlert(row: { id: string; kind: string; subject: string; level: string; details: unknown; createdAt: Date; notifiedAt: Date | null; resolvedAt: Date | null }): AdminAlert | null {
  const parsed = adminAlertSchema.safeParse({
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    level: row.level,
    details: row.details ?? {},
    createdAt: row.createdAt.toISOString(),
    notifiedAt: row.notifiedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Santé technique (écran 9, remplace `GET health/config`) : jobs, consommation des API externes, taux d'erreur de l'API,
 * e-mails, push, taille de la base, services configurés (sans aucune valeur) et alertes admin.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger('AdminHealth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobHealthReader,
    private readonly counters: DailyCounters,
    private readonly usage: UpstreamUsageReader,
    private readonly analytics: AnalyticsService,
    private readonly billing: BillingProvider,
    private readonly push: PushSender,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async quotas(now: Date): Promise<AdminQuotaUsage[]> {
    try {
      const snapshot = await this.usage.snapshot(utcDay(now));
      return quotasWithBudgets(snapshot, this.config.admin, this.config.admin.alertQuotaRatio);
    } catch (error) {
      this.logger.warn(`Compteurs des sources illisibles (${errorCode(error)})`);
      return [];
    }
  }

  services(): Record<string, 'configured' | 'not_configured'> {
    const services: Record<string, 'configured' | 'not_configured'> = {};
    for (const [name, configured] of Object.entries(this.config.services)) services[snakeCase(name)] = configured ? 'configured' : 'not_configured';
    // Stripe utilisable seulement en mode réel (clés et prix valides) ; simulation ou indisponible : non configuré.
    services['stripe'] = this.billing.mode() === 'stripe' ? 'configured' : 'not_configured';
    services['ga4_data_api'] = this.analytics.isConfigured('ga4') ? 'configured' : 'not_configured';
    services['search_console'] = this.analytics.isConfigured('search_console') ? 'configured' : 'not_configured';
    services['push'] = this.push.configured ? 'configured' : 'not_configured';
    return services;
  }

  async health(now: Date): Promise<AdminHealth> {
    const today = utcDay(now);
    const [jobs, quotas, todayCounters, yesterdayCounters, pushSubscriptions, sizeBytes, alertRows] = await Promise.all([
      this.jobs.states(now),
      this.quotas(now),
      this.counters.read(today),
      this.counters.read(addDays(today, -1)),
      this.prisma.pushSubscription.count(),
      databaseSize(this.prisma),
      this.prisma.adminAlert.findMany({ orderBy: [{ resolvedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }], take: 20 }),
    ]);
    const requests = last24h(todayCounters, yesterdayCounters, now, 'api_requests');
    const serverErrors = Math.min(requests, last24h(todayCounters, yesterdayCounters, now, 'api_errors_5xx'));
    const pushProvider = this.config.push.provider === 'fake' && !this.config.isProduction ? 'fake' : this.push.configured ? 'webpush' : 'unavailable';
    return adminHealthSchema.parse({
      generatedAt: now.toISOString(),
      jobs: jobs.map(toJobHealth),
      quotas,
      api: {
        window: '24h',
        requests,
        serverErrors,
        errorRate: requests > 0 ? serverErrors / requests : null,
        estimated: last24hEstimated(yesterdayCounters, now),
      },
      emails: {
        provider: this.config.mail.provider === 'resend' && this.config.mail.resendApiKey ? 'resend' : 'smtp',
        sent24h: last24h(todayCounters, yesterdayCounters, now, 'emails_sent'),
        failed24h: last24h(todayCounters, yesterdayCounters, now, 'emails_failed'),
      },
      push: { provider: pushProvider, activeSubscriptions: pushSubscriptions },
      database: { sizeBytes },
      services: this.services(),
      alerts: alertRows.map(toAdminAlert).filter((alert): alert is AdminAlert => alert !== null),
    });
  }
}
