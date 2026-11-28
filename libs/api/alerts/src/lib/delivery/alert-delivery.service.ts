import { Inject, Injectable, Logger } from '@nestjs/common';
import { AnalysisClock } from '@raijin/api-analysis';
import { APP_CONFIG, errorCode, type AppConfig } from '@raijin/api-core';
import { AlertMailService, buildAlertPushPayload, PUSH_TTL_SECONDS, PushSender, type AlertMessage } from '@raijin/api-notifications';
import { PrismaService } from '@raijin/api-prisma';
import { randomUUID } from 'node:crypto';
import { alertRowSelect, toAlertMessage, type AlertRow } from '../alerts/alert-view';
import { planLimitsOf } from '../plan/plan-limits.service';
import { EventRecorderService } from '../watch/event-recorder.service';

/** Compteur interne des e-mails d'alerte (plafond `ALERT_EMAIL_DAILY_MAX` par jour UTC). */
export const ALERT_EMAIL_KIND = 'alert_email';
/** Alertes plus anciennes : jamais envoyées en retard (évite un rattrapage massif après une panne). */
export const EMAIL_MAX_AGE_MS = 24 * 3_600_000;
/** Lignes par e-mail groupé. */
export const EMAIL_MAX_ALERTS = 20;

/** Échec d'envoi à rejouer (BullMQ, backoff) : code seulement. */
export class DeliveryRetryError extends Error {
  constructor(readonly code: string) {
    super(`Envoi à rejouer (${code})`);
    this.name = 'DeliveryRetryError';
  }
}

/**
 * Livraison des alertes (docs/ARCHITECTURE.md §11.6) : réservation `UPDATE … WHERE … IS NULL` avant
 * l'envoi (jamais deux fois), relâchée si l'envoi échoue (reprise BullMQ). Push par alerte (Pro et
 * essai, préférence active), 404/410 → abonnement supprimé ; e-mail groupé par utilisateur, e-mail
 * vérifié exigé, plafond journalier. Ni l'endpoint ni l'adresse ne sont journalisés.
 */
@Injectable()
export class AlertDeliveryService {
  private readonly logger = new Logger('AlertDelivery');

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushSender,
    private readonly mail: AlertMailService,
    private readonly recorder: EventRecorderService,
    private readonly clock: AnalysisClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async deliverPush(alertId: string): Promise<{ sent: number; removed: number; skipped: boolean }> {
    const alert = await this.prisma.alert.findUnique({
      where: { id: alertId },
      select: { ...alertRowSelect, userId: true, pushedAt: true, user: { select: { plan: true, trialStatus: true, trialEndsAt: true, notifyPushAlerts: true } } },
    });
    if (!alert || alert.pushedAt !== null || !this.push.configured) return { sent: 0, removed: 0, skipped: true };
    const allowed = planLimitsOf(alert.user, this.clock.now(), this.config).pushAlerts && alert.user.notifyPushAlerts;
    const message = toAlertMessage(alert);
    if (!allowed || !message) return { sent: 0, removed: 0, skipped: true };
    const subscriptions = await this.prisma.pushSubscription.findMany({ where: { userId: alert.userId }, select: { id: true, endpoint: true, p256dh: true, auth: true } });
    if (subscriptions.length === 0) return { sent: 0, removed: 0, skipped: true };

    const reserved = await this.prisma.alert.updateMany({ where: { id: alertId, pushedAt: null }, data: { pushedAt: this.clock.now() } });
    if (reserved.count === 0) return { sent: 0, removed: 0, skipped: true };

    const payload = buildAlertPushPayload(message);
    const options = { ttlSeconds: PUSH_TTL_SECONDS, urgency: message.severity === 'danger' ? ('high' as const) : ('normal' as const) };
    let sent = 0;
    let removed = 0;
    const failures: string[] = [];
    for (const subscription of subscriptions) {
      const result = await this.push.send(subscription, payload, options);
      if (result.status === 'sent') {
        sent += 1;
        await this.prisma.pushSubscription.updateMany({ where: { id: subscription.id }, data: { lastSuccessAt: this.clock.now() } });
      } else if (result.status === 'gone') {
        removed += 1;
        await this.prisma.pushSubscription.deleteMany({ where: { id: subscription.id } });
      } else {
        failures.push(result.code);
      }
    }
    if (failures.length > 0) this.logger.warn(`Push en échec (${[...new Set(failures)].join(',')})`);
    if (sent === 0 && failures.length > 0) {
      await this.prisma.alert.updateMany({ where: { id: alertId }, data: { pushedAt: null } });
      throw new DeliveryRetryError(failures[0] ?? 'PUSH_ERROR');
    }
    return { sent, removed, skipped: false };
  }

  /** E-mail groupé des alertes en attente d'un utilisateur. */
  async deliverEmail(userId: string): Promise<{ sent: boolean; alerts: number; skipped: number }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true, notifyEmailAlerts: true, suspendedAt: true } });
    if (!user) return { sent: false, alerts: 0, skipped: 0 };
    const now = this.clock.now();
    const since = new Date(now.getTime() - EMAIL_MAX_AGE_MS);
    // Compte suspendu par un admin (phase 6 bis) : aucun e-mail, alertes marquées non envoyées.
    if (!user.emailVerifiedAt || !user.notifyEmailAlerts || user.suspendedAt) {
      const skipped = await this.prisma.alert.updateMany({ where: { userId, emailedAt: null, emailSkipped: false }, data: { emailSkipped: true } });
      return { sent: false, alerts: 0, skipped: skipped.count };
    }
    // Réservation atomique (une autre exécution ne prend jamais les mêmes lignes).
    const reserved = await this.prisma.$queryRaw<AlertRow[]>`
      UPDATE "Alert" SET "emailedAt" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "Alert"
        WHERE "userId" = ${userId}::uuid AND "emailedAt" IS NULL AND "emailSkipped" = false AND "createdAt" >= ${since}
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT ${EMAIL_MAX_ALERTS}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "mint", "type", "severity"::text AS "severity", "payload", "token", "readAt", "createdAt"`;
    if (reserved.length === 0) return { sent: false, alerts: 0, skipped: 0 };
    const ids = reserved.map((row) => row.id);
    const day = now.toISOString().slice(0, 10);

    if (!(await this.reserveDailyEmail(userId, day))) {
      await this.prisma.alert.updateMany({ where: { id: { in: ids } }, data: { emailedAt: null, emailSkipped: true } });
      return { sent: false, alerts: 0, skipped: ids.length };
    }
    const messages = reserved
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(toAlertMessage)
      .filter((message): message is AlertMessage => message !== null);
    try {
      if (messages.length > 0) await this.mail.sendAlerts(user.email, messages);
    } catch (error) {
      await this.prisma.alert.updateMany({ where: { id: { in: ids } }, data: { emailedAt: null } });
      await this.prisma.$executeRaw`
        UPDATE "UsageCounter" SET "count" = "count" - 1
        WHERE "userId" = ${userId}::uuid AND "kind" = ${ALERT_EMAIL_KIND} AND "day" = ${day}::date AND "count" > 0`;
      throw new DeliveryRetryError(errorCode(error));
    }
    // Reliquat au-delà de 20 lignes : un autre e-mail à la fenêtre suivante.
    const remaining = await this.prisma.alert.count({ where: { userId, emailedAt: null, emailSkipped: false, createdAt: { gte: since } } });
    if (remaining > 0) await this.recorder.enqueueEmail(userId, now);
    return { sent: messages.length > 0, alerts: messages.length, skipped: 0 };
  }

  /** Utilisateurs ayant des alertes en attente d'e-mail (déclenchement manuel des tests, rattrapage). */
  async pendingEmailUsers(): Promise<string[]> {
    const since = new Date(this.clock.now().getTime() - EMAIL_MAX_AGE_MS);
    const rows = await this.prisma.alert.findMany({ where: { emailedAt: null, emailSkipped: false, createdAt: { gte: since } }, distinct: ['userId'], select: { userId: true }, take: 500 });
    return rows.map((row) => row.userId);
  }

  private async reserveDailyEmail(userId: string, day: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "UsageCounter" ("id", "userId", "ipHash", "kind", "day", "count")
      VALUES (${randomUUID()}::uuid, ${userId}::uuid, NULL, ${ALERT_EMAIL_KIND}, ${day}::date, 1)
      ON CONFLICT ("userId", "kind", "day")
      DO UPDATE SET "count" = "UsageCounter"."count" + 1 WHERE "UsageCounter"."count" < ${this.config.watch.emailDailyMax}
      RETURNING "count"`;
    return rows.length > 0 && this.config.watch.emailDailyMax > 0;
  }
}
