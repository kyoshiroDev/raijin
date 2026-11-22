import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '@raijin/api-core';
import { PushSender } from '@raijin/api-notifications';
import { PrismaService } from '@raijin/api-prisma';
import { WATCH_ERROR_MESSAGES, type NotificationPreferencesUpdate, type NotificationSettings } from '@raijin/shared-contracts';
import { PlanLimitsService } from '../plan/plan-limits.service';

/** Préférences de notification et état réel du push (plan, clés VAPID, appareils, e-mail vérifié). */
@Injectable()
export class NotificationSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanLimitsService,
    private readonly push: PushSender,
  ) {}

  async settings(userId: string): Promise<NotificationSettings> {
    const rights = await this.plans.rights(userId);
    const pushDevices = await this.prisma.pushSubscription.count({ where: { userId } });
    return {
      preferences: rights.preferences,
      pushAllowed: rights.limits.pushAlerts,
      pushConfigured: this.push.configured,
      pushDevices,
      emailVerified: rights.emailVerified,
    };
  }

  /** Activer le push est réservé au Pro et à l'essai (`PUSH_PLAN_REQUIRED`) ; le désactiver, toujours permis. */
  async update(userId: string, patch: NotificationPreferencesUpdate): Promise<NotificationSettings> {
    const rights = await this.plans.rights(userId);
    if (patch.pushAlerts === true && !rights.limits.pushAlerts) {
      throw new ApiException('PUSH_PLAN_REQUIRED', HttpStatus.FORBIDDEN, WATCH_ERROR_MESSAGES.PUSH_PLAN_REQUIRED);
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(patch.emailAlerts !== undefined ? { notifyEmailAlerts: patch.emailAlerts } : {}),
        ...(patch.pushAlerts !== undefined ? { notifyPushAlerts: patch.pushAlerts } : {}),
        ...(patch.weeklyDigest !== undefined ? { notifyWeeklyDigest: patch.weeklyDigest } : {}),
      },
    });
    return this.settings(userId);
  }
}
