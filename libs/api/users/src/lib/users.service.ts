import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiException, errorCode } from '@raijin/api-core';
import {
  AuditService,
  AuthService,
  SessionService,
  toPublicUser,
  type ClientInfo,
} from '@raijin/api-auth';
import { PrismaService } from '@raijin/api-prisma';
import type { PublicUser } from '@raijin/shared-contracts';
import { AccountBillingCloser } from './account-billing-closer';

/** Compte de l'utilisateur connecté : profil, export et suppression (RGPD). */
@Injectable()
export class UsersService {
  private readonly logger = new Logger('Users');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly billing: AccountBillingCloser,
  ) {}

  async me(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    return toPublicUser(user);
  }

  /**
   * Export RGPD (droit d'accès et portabilité) : toutes les données liées au compte, sans secret
   * (pas de hash de mot de passe, de jeton, de secret TOTP ni d'empreinte d'IP).
   */
  async export(userId: string, client: ClientInfo): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
        plan: true,
        role: true,
        trialStatus: true,
        trialStartedAt: true,
        trialEndsAt: true,
        trialDay1MailAt: true,
        trialDayMinus2MailAt: true,
        trialEndMailAt: true,
        trialEndScreenSeenAt: true,
        notifyEmailAlerts: true,
        notifyPushAlerts: true,
        notifyWeeklyDigest: true,
        notifyTrialEmails: true,
        stripeCustomerId: true,
        termsAcceptedAt: true,
        passwordChangedAt: true,
        lastLoginAt: true,
        utmSource: true,
        utmMedium: true,
        utmCampaign: true,
        referrer: true,
        landingPath: true,
        createdAt: true,
        updatedAt: true,
        sessions: {
          select: { createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true, userAgent: true },
          orderBy: { createdAt: 'desc' },
        },
        subscriptions: {
          select: { status: true, interval: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, createdAt: true, updatedAt: true },
        },
        watches: { select: { mint: true, lastVerdict: true, lastCheckedAt: true, createdAt: true } },
        alerts: { select: { mint: true, type: true, payload: true, readAt: true, createdAt: true } },
        tokenAnalyses: { select: { mint: true, verdict: true, score: true, createdAt: true } },
        pushSubscriptions: { select: { userAgent: true, createdAt: true } },
        usageCounters: { select: { kind: true, day: true, count: true } },
        productEvents: { select: { type: true, properties: true, createdAt: true } },
        auditLogs: { select: { action: true, userAgent: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    await this.audit.record('account.exported', userId, client);
    // Identifiant du client de paiement jamais exporté brut : seulement son existence.
    const { stripeCustomerId, ...account } = user;
    return { exportedAt: new Date().toISOString(), format: 'raijin-export-v1', account: { ...account, hasPaymentCustomer: stripeCustomerId !== null } };
  }

  /** Suppression définitive, confirmée par le mot de passe. Les journaux d'audit sont anonymisés. */
  async delete(userId: string, password: string, client: ClientInfo): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    // Même compteur d'échecs que la connexion (verrouillage) ; échecs audités (account.delete_failed).
    await this.auth.confirmPassword(user, password, client, 'account.delete');
    // Abonnement résilié chez le prestataire AVANT toute suppression ; en cas d'échec, le compte est conservé.
    try {
      await this.billing.closeForUser(userId);
    } catch (error) {
      this.logger.error(`Clôture de la facturation impossible, compte conservé (${errorCode(error)})`);
      await this.audit.record('account.delete_billing_failed', userId, client);
      if (error instanceof ApiException) throw error;
      throw new ApiException('UPSTREAM_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
    }
    await this.sessions.revokeAllForUser(userId, 'account_deleted');
    await this.audit.record('account.deleted', userId, client);
    // Cascade : sessions, jetons, suivis, alertes, abonnements push, quotas, TOTP.
    // SetNull : audit, événements produit, analyses, empreintes d'essai (anti-abus, purgées à 90 j).
    await this.prisma.user.delete({ where: { id: userId } });
  }
}
