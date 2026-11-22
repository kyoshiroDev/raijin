import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AnalysisClock } from '@raijin/api-analysis';
import { APP_CONFIG, ApiException, type AppConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import type { NotificationPreferences, PlanLimits } from '@raijin/shared-contracts';

/** Droits du compte relus en base à chaque requête (jamais depuis le jeton ni le front). */
export interface AccountRights {
  readonly userId: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** Pro payé ou essai actif. */
  readonly pro: boolean;
  readonly limits: PlanLimits;
  readonly preferences: NotificationPreferences;
}

interface PlanRow {
  readonly plan: 'FREE' | 'PRO';
  readonly trialStatus: string;
  readonly trialEndsAt: Date | null;
}

/** Calcul pur des limites (plan, essai, configuration). */
export function planLimitsOf(user: PlanRow, now: Date, config: AppConfig): PlanLimits {
  const trialActive = user.trialStatus === 'ACTIVE' && !!user.trialEndsAt && user.trialEndsAt > now;
  const pro = user.plan === 'PRO' || trialActive;
  return {
    plan: user.plan,
    trialActive,
    maxActiveWatches: pro ? config.watch.proLimit : config.watch.freeLimit,
    pushAlerts: pro,
    alertHistoryDays: pro ? config.watch.proAlertHistoryDays : config.watch.freeAlertHistoryDays,
  };
}

/** Limites par plan (`FREE_/PRO_WATCH_LIMIT`, essai = Pro), docs/ARCHITECTURE.md §11.5. */
@Injectable()
export class PlanLimitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: AnalysisClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async rights(userId: string): Promise<AccountRights> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        emailVerifiedAt: true,
        plan: true,
        trialStatus: true,
        trialEndsAt: true,
        notifyEmailAlerts: true,
        notifyPushAlerts: true,
        notifyWeeklyDigest: true,
      },
    });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    const limits = planLimitsOf(user, this.clock.now(), this.config);
    return {
      userId,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      pro: limits.pushAlerts,
      limits,
      preferences: { emailAlerts: user.notifyEmailAlerts, pushAlerts: user.notifyPushAlerts, weeklyDigest: user.notifyWeeklyDigest },
    };
  }

  /** Droits d'un compte à l'e-mail vérifié, sinon 403 `AUTH_EMAIL_NOT_VERIFIED`. */
  async verifiedRights(userId: string): Promise<AccountRights> {
    const rights = await this.rights(userId);
    if (!rights.emailVerified) throw ApiException.auth('AUTH_EMAIL_NOT_VERIFIED', HttpStatus.FORBIDDEN);
    return rights;
  }
}
