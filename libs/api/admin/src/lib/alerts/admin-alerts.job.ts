import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRegistry, JobRunService } from '@raijin/api-alerts';
import { APP_CONFIG, errorCode, randomToken, type AppConfig } from '@raijin/api-core';
import { adminAlertTemplate, Mailer, PushSender, type AdminAlertMailItem } from '@raijin/api-notifications';
import { Prisma, PrismaService } from '@raijin/api-prisma';
import {
  ADMIN_JOB_LABELS,
  QUOTA_SERVICE_LABELS,
  quotaServiceSchema,
  type AdminAlert,
  type AdminPushNotificationPayload,
} from '@raijin/shared-contracts';
import { AdminStore } from '../common/admin-store';
import { utcDay } from '../common/range';
import { toAdminAlert } from '../health/health.service';
import { JobHealthReader } from '../health/job-health';
import { HealthService } from '../health/health.service';

export const ADMIN_ALERTS_JOB = 'admin-alerts';
export const ADMIN_ALERTS_LOCK_KEY = 'lock:admin-alerts';
const LOCK_TTL_S = 5 * 60;
/** Alertes non notifiées reprises par passage (au-delà : au passage suivant). */
const NOTIFY_BATCH = 20;

export interface AdminAlertsResult {
  readonly [key: string]: number;
  readonly opened: number;
  readonly resolved: number;
  readonly notified: number;
  readonly failed: number;
}

export function jobAlertKey(job: string, firstFailureId: string): string {
  return `job_failing:${job}:${firstFailureId}`;
}

export function quotaAlertKey(service: string, day: string): string {
  return `quota:${service}:${day}`;
}

/** Libellé d'un sujet d'alerte (texte maîtrisé par Raijin ; nom brut pour un job inconnu). */
export function alertLabel(alert: Pick<AdminAlert, 'kind' | 'subject'>): string {
  if (alert.kind === 'quota_threshold') {
    const service = quotaServiceSchema.safeParse(alert.subject);
    return service.success ? QUOTA_SERVICE_LABELS[service.data] : alert.subject;
  }
  return ADMIN_JOB_LABELS[alert.subject] ?? alert.subject;
}

/**
 * Notification push d'une alerte admin, au format du service worker Angular (titre, texte, clic → santé technique).
 * Le contrat `pushNotificationPayloadSchema` est propre aux alertes de token (`tag alert:<mint>`) : cette charge utile
 * a la même enveloppe (`notification`, `data.onActionClick`) mais un `tag` et des données propres à l'admin.
 */
export function adminPushPayload(alerts: readonly AdminAlert[], now: Date): AdminPushNotificationPayload {
  const first = alerts[0];
  const title = alerts.length === 1 ? 'Raijin admin : alerte technique' : `Raijin admin : ${alerts.length} alertes techniques`;
  const body = first ? `${alertLabel(first)}${alerts.length > 1 ? ` et ${alerts.length - 1} autre(s)` : ''}. Ouvre la santé technique.` : 'Ouvre la santé technique.';
  return {
    notification: {
      title: title.slice(0, 80),
      body: body.slice(0, 240),
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: 'admin-alert',
      renotify: true,
      lang: 'fr',
      timestamp: now.getTime(),
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: '/admin/sante' } } },
    },
  };
}

/**
 * Job `admin-alerts` (`ADMIN_ALERTS_CRON`, toutes les 10 min ; docs/ARCHITECTURE.md §14.7) :
 * 1. ouvre une alerte par job dont les `ADMIN_ALERT_JOB_FAILURES` dernières exécutions ont échoué
 *    (`job_failing:<job>:<id du premier échec>`), résolue au prochain succès ;
 * 2. ouvre une alerte par quota du jour ≥ `ADMIN_ALERT_QUOTA_RATIO` (`quota:<service>:<jour>`), résolue au jour suivant ;
 * 3. envoie les alertes non notifiées par e-mail à chaque compte ADMIN et en push sur ses appareils ; `notifiedAt` est
 *    posé après un envoi réussi, sinon nouvel essai au passage suivant. Déduplication par `AdminAlert.dedupeKey`.
 */
@Injectable()
export class AdminAlertsJob implements OnModuleInit {
  private readonly logger = new Logger('AdminAlerts');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobHealthReader,
    private readonly health: HealthService,
    private readonly registry: JobRegistry,
    private readonly runs: JobRunService,
    private readonly store: AdminStore,
    private readonly mailer: Mailer,
    private readonly push: PushSender,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: ADMIN_ALERTS_JOB,
      queue: 'maintenance',
      scheduler: { pattern: this.config.admin.alertsCron, tz: 'UTC' },
      manualRun: true,
      handler: async () => this.run(new Date()),
    });
  }

  async run(now: Date = new Date()): Promise<AdminAlertsResult | { locked: true }> {
    const owner = randomToken(12);
    if ((await this.store.setIfAbsent(ADMIN_ALERTS_LOCK_KEY, owner, LOCK_TTL_S)) === false) return { locked: true };
    try {
      return await this.runs.track(ADMIN_ALERTS_JOB, () => this.check(now));
    } finally {
      await this.store.deleteIfEquals(ADMIN_ALERTS_LOCK_KEY, owner);
    }
  }

  private async check(now: Date): Promise<AdminAlertsResult> {
    let opened = 0;
    let resolved = 0;
    const threshold = this.config.admin.alertJobFailures;

    // 1. Jobs en échec répété (le job d'alertes se surveille lui-même : son échec apparaît au passage suivant).
    const states = await this.jobs.states(now);
    for (const state of states) {
      if (state.consecutiveFailures >= threshold && state.firstFailureId) {
        opened += await this.open(jobAlertKey(state.name, state.firstFailureId), 'job_failing', state.name, 'critical', {
          consecutiveFailures: state.consecutiveFailures,
          ...(state.lastErrorCode ? { lastErrorCode: state.lastErrorCode } : {}),
        });
      }
      if (state.lastSuccessAt) {
        const done = await this.prisma.adminAlert.updateMany({
          where: { kind: 'job_failing', subject: state.name, resolvedAt: null, createdAt: { lt: state.lastSuccessAt } },
          data: { resolvedAt: now },
        });
        resolved += done.count;
      }
    }

    // 2. Quotas du jour UTC.
    const day = utcDay(now);
    for (const quota of await this.health.quotas(now)) {
      if (quota.ratio === null || quota.limit === null || quota.ratio < this.config.admin.alertQuotaRatio) continue;
      opened += await this.open(quotaAlertKey(quota.service, day), 'quota_threshold', quota.service, quota.ratio >= 1 ? 'critical' : 'warning', {
        used: quota.used,
        limit: quota.limit,
        ratio: Math.round(quota.ratio * 1000) / 1000,
      });
    }
    const stale = await this.prisma.adminAlert.updateMany({
      where: { kind: 'quota_threshold', resolvedAt: null, NOT: { dedupeKey: { endsWith: `:${day}` } } },
      data: { resolvedAt: now },
    });
    resolved += stale.count;

    // 3. Notifications.
    const { notified, failed } = await this.notify(now);
    return { opened, resolved, notified, failed };
  }

  /** Crée l'alerte si elle n'existe pas encore (une seule par incident) ; 1 si créée. */
  private async open(dedupeKey: string, kind: AdminAlert['kind'], subject: string, level: AdminAlert['level'], details: AdminAlert['details']): Promise<number> {
    const created = await this.prisma.adminAlert.createMany({
      data: [{ dedupeKey, kind, subject: subject.slice(0, 64), level, details: details as Prisma.InputJsonObject }],
      skipDuplicates: true,
    });
    return created.count;
  }

  private async notify(now: Date): Promise<{ notified: number; failed: number }> {
    const rows = await this.prisma.adminAlert.findMany({ where: { notifiedAt: null, resolvedAt: null }, orderBy: { createdAt: 'asc' }, take: NOTIFY_BATCH });
    const alerts = rows.map(toAdminAlert).filter((alert): alert is AdminAlert => alert !== null);
    if (alerts.length === 0) return { notified: 0, failed: 0 };
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', suspendedAt: null, emailVerifiedAt: { not: null } },
      select: { id: true, email: true, pushSubscriptions: { select: { endpoint: true, p256dh: true, auth: true } } },
    });
    if (admins.length === 0) return { notified: 0, failed: alerts.length };

    const items: AdminAlertMailItem[] = alerts.map((alert) => ({ kind: alert.kind, label: alertLabel(alert), level: alert.level, ...alert.details }));
    const mail = adminAlertTemplate({ logoUrl: this.config.mail.logoUrl, appUrl: this.config.appUrl }, items);
    const payload = adminPushPayload(alerts, now);
    let delivered = false;
    for (const admin of admins) {
      try {
        await this.mailer.send({ to: admin.email, ...mail });
        delivered = true;
      } catch (error) {
        this.logger.warn(`E-mail d'alerte admin non envoyé (${errorCode(error)})`);
      }
      // Push sans condition de plan pour ce type ; un abonnement expiré est ignoré ici (purgé par les envois d'alertes).
      for (const target of admin.pushSubscriptions) {
        const result = await this.push.send(target, payload, { ttlSeconds: 3_600, urgency: 'high' }).catch(() => ({ status: 'failed' as const, code: 'PUSH_ERROR' }));
        if (result.status === 'sent') delivered = true;
      }
    }
    if (!delivered) return { notified: 0, failed: alerts.length };
    const updated = await this.prisma.adminAlert.updateMany({ where: { id: { in: alerts.map((alert) => alert.id) }, notifiedAt: null }, data: { notifiedAt: now } });
    return { notified: updated.count, failed: 0 };
  }
}
