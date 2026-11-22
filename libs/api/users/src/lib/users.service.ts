import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '@raijin/api-core';
import {
  AuditService,
  AuthService,
  SessionService,
  toPublicUser,
  type ClientInfo,
} from '@raijin/api-auth';
import { PrismaService } from '@raijin/api-prisma';
import type { PublicUser } from '@raijin/shared-contracts';

/** Compte de l'utilisateur connecté : profil, export et suppression (RGPD). */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
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
          select: { status: true, interval: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, createdAt: true },
        },
        watches: { select: { mint: true, lastVerdict: true, lastCheckedAt: true, createdAt: true } },
        alerts: { select: { mint: true, type: true, payload: true, readAt: true, createdAt: true } },
        tokenAnalyses: { select: { mint: true, verdict: true, score: true, createdAt: true } },
        pushSubscriptions: { select: { userAgent: true, createdAt: true } },
        usageCounters: { select: { kind: true, day: true, count: true } },
        productEvents: { select: { type: true, createdAt: true } },
        auditLogs: { select: { action: true, userAgent: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    await this.audit.record('account.exported', userId, client);
    return { exportedAt: new Date().toISOString(), format: 'raijin-export-v1', account: user };
  }

  /** Suppression définitive, confirmée par le mot de passe. Les journaux d'audit sont anonymisés. */
  async delete(userId: string, password: string, client: ClientInfo): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    // Même compteur d'échecs que la connexion (verrouillage) ; échecs audités (account.delete_failed).
    await this.auth.confirmPassword(user, password, client, 'account.delete');
    await this.sessions.revokeAllForUser(userId, 'account_deleted');
    await this.audit.record('account.deleted', userId, client);
    // Cascade : sessions, jetons, suivis, alertes, abonnements push, quotas, TOTP.
    // SetNull : audit, événements produit, analyses, empreintes d'essai (anti-abus, purgées à 90 j).
    await this.prisma.user.delete({ where: { id: userId } });
  }
}
