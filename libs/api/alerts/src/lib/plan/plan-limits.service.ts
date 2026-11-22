import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AnalysisClock } from '@raijin/api-analysis';
import {
  APP_CONFIG,
  ApiException,
  PLAN_POLICY_USER_SELECT,
  planPolicyLimits,
  resolvePlanPolicy,
  type AppConfig,
  type PlanPolicy,
  type PlanPolicyRow,
} from '@raijin/api-core';
import { PrismaService, type Prisma } from '@raijin/api-prisma';
import type { NotificationPreferences, PlanLimits } from '@raijin/shared-contracts';

/** Droits du compte relus en base à chaque requête (jamais depuis le jeton ni le front). */
export interface AccountRights {
  readonly userId: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** Pro payé ou essai actif. */
  readonly pro: boolean;
  readonly limits: PlanLimits;
  readonly policy: PlanPolicy;
  readonly preferences: NotificationPreferences;
}

/** Limites des suivis (contrat `PlanLimits`) tirées de la politique unique `resolvePlanPolicy`. */
export function planLimitsFromPolicy(policy: PlanPolicy): PlanLimits {
  return {
    plan: policy.paidPlan,
    trialActive: policy.trialActive,
    maxActiveWatches: policy.entitlements.maxActiveWatches,
    pushAlerts: policy.entitlements.pushAlerts,
    alertHistoryDays: policy.entitlements.alertHistoryDays,
  };
}

/** Calcul pur des limites (plan, essai, configuration), via `resolvePlanPolicy`. */
export function planLimitsOf(user: PlanPolicyRow, now: Date, config: AppConfig): PlanLimits {
  return planLimitsFromPolicy(resolvePlanPolicy(user, planPolicyLimits(config), now));
}

/** Limites par plan (`FREE_/PRO_WATCH_LIMIT`, essai = Pro), docs/ARCHITECTURE.md §11.5 et §13.4 (`resolvePlanPolicy`). */
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
        ...PLAN_POLICY_USER_SELECT,
        email: true,
        notifyEmailAlerts: true,
        notifyPushAlerts: true,
        notifyWeeklyDigest: true,
        notifyTrialEmails: true,
      },
    });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    const policy = resolvePlanPolicy(user, planPolicyLimits(this.config), this.clock.now());
    const limits = planLimitsFromPolicy(policy);
    return {
      userId,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      pro: policy.effectivePlan === 'PRO',
      limits,
      policy,
      preferences: {
        emailAlerts: user.notifyEmailAlerts,
        pushAlerts: user.notifyPushAlerts,
        weeklyDigest: user.notifyWeeklyDigest,
        trialEmails: user.notifyTrialEmails,
      },
    };
  }

  /**
   * Politique relue **dans une transaction** (fin d'essai, passage Pro / Gratuit par l'abonnement) : la
   * ligne `User` vue par la transaction, après ses propres écritures.
   */
  async policyIn(tx: Prisma.TransactionClient, userId: string): Promise<PlanPolicy> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: PLAN_POLICY_USER_SELECT });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    return resolvePlanPolicy(user, planPolicyLimits(this.config), this.clock.now());
  }

  /** Droits d'un compte à l'e-mail vérifié, sinon 403 `AUTH_EMAIL_NOT_VERIFIED`. */
  async verifiedRights(userId: string): Promise<AccountRights> {
    const rights = await this.rights(userId);
    if (!rights.emailVerified) throw ApiException.auth('AUTH_EMAIL_NOT_VERIFIED', HttpStatus.FORBIDDEN);
    return rights;
  }
}
