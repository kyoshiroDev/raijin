import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, ApiException, randomToken, sha256, type AppConfig } from '@raijin/api-core';
import { PrismaService, type Session } from '@raijin/api-prisma';
import { AuditService } from '../audit/audit.service';
import type { ClientInfo } from './client-info';

/**
 * Fenêtre pendant laquelle un refresh déjà utilisé est refusé sans révoquer la famille :
 * deux onglets qui rafraîchissent en même temps ne déconnectent pas l'utilisateur.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000;

export const REFRESH_CONFLICT_MESSAGE = 'Ta session vient d’être rafraîchie ailleurs. Réessaie.';

export type RevocationReason =
  | 'logout'
  | 'reuse'
  | 'password_reset'
  | 'password_change'
  | 'account_deleted';

export interface IssuedRefresh {
  readonly session: Session;
  readonly refreshToken: string;
}

/**
 * Sessions = familles de refresh tokens opaques (32 octets, SHA-256 en base).
 * Rotation à chaque refresh ; un refresh déjà utilisé révoque toute la famille.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(userId: string, client: ClientInfo): Promise<IssuedRefresh> {
    const refreshToken = randomToken(32);
    const expiresAt = new Date(Date.now() + this.config.auth.refreshTtlMs);
    const session = await this.prisma.session.create({
      data: {
        userId,
        userAgent: client.userAgent,
        ipHash: this.audit.hashIp(client.ip),
        expiresAt,
        refreshTokens: { create: { tokenHash: sha256(refreshToken), expiresAt } },
      },
    });
    return { session, refreshToken };
  }

  /** Échange un refresh valide contre un nouveau (même session). Erreur : 401 AUTH_SESSION_EXPIRED. */
  async rotate(rawToken: string, client: ClientInfo): Promise<IssuedRefresh> {
    const now = new Date();
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { session: true },
    });
    if (!record) throw expired();

    if (record.usedAt) {
      if (now.getTime() - record.usedAt.getTime() <= REFRESH_REUSE_GRACE_MS) {
        // Rafraîchissement concurrent (autre onglet) : les cookies ont déjà été tournés par l'autre
        // requête. 409 CONFLICT : le front rejoue sa requête sans se déconnecter (cookies conservés).
        throw new ApiException('CONFLICT', HttpStatus.CONFLICT, REFRESH_CONFLICT_MESSAGE);
      }
      await this.revoke(record.sessionId, 'reuse');
      await this.audit.record('auth.refresh_reuse_detected', record.session.userId, client, {
        sessionId: record.sessionId,
      });
      throw expired();
    }
    const session = record.session;
    if (record.expiresAt <= now || session.revokedAt || session.expiresAt <= now) throw expired();

    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw expired();

    const refreshToken = randomToken(32);
    const expiresAt = new Date(now.getTime() + this.config.auth.refreshTtlMs);
    const [, updated] = await this.prisma.$transaction([
      this.prisma.refreshToken.create({
        data: { sessionId: session.id, tokenHash: sha256(refreshToken), expiresAt },
      }),
      this.prisma.session.update({
        where: { id: session.id },
        data: { lastUsedAt: now, expiresAt, userAgent: client.userAgent ?? session.userAgent },
      }),
    ]);
    return { session: updated, refreshToken };
  }

  /** Session active (non révoquée, non expirée) appartenant à l'utilisateur. */
  async isActive(sessionId: string, userId: string): Promise<boolean> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true, revokedAt: true, expiresAt: true },
    });
    return !!session && session.userId === userId && !session.revokedAt && session.expiresAt > new Date();
  }

  /** Session à laquelle appartient un refresh (déconnexion sans access token). */
  async sessionIdForRefresh(rawToken: string): Promise<string | null> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      select: { sessionId: true },
    });
    return record?.sessionId ?? null;
  }

  async revoke(sessionId: string, reason: RevocationReason): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /**
   * Révoque toutes les sessions du compte (sauf `exceptSessionId`) et supprime ses abonnements push :
   * après une réinitialisation ou un changement de mot de passe (compte peut-être compromis), un appareil
   * resté abonné ne doit plus recevoir d'alertes. Le front se réabonne après une nouvelle connexion.
   */
  async revokeAllForUser(userId: string, reason: RevocationReason, exceptSessionId?: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.prisma.pushSubscription.deleteMany({ where: { userId } });
    return result.count;
  }
}

function expired(): ApiException {
  return ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
}
