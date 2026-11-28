import { applyDecorators, CanActivate, ExecutionContext, HttpStatus, Inject, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';
import { APP_CONFIG, ApiException, type AppConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import type { Request, Response } from 'express';
import { AuthGuard, type AuthContext } from '../http/auth.guard';
import { ADMIN_LAST_SEEN_THROTTLE_MS, adminSessionState } from './admin-session';

/**
 * Étape de sécurité exigée par une route admin :
 * - `full` (défaut) : rôle ADMIN + 2FA activée + session admin vérifiée et non expirée ;
 * - `verify` : rôle ADMIN + 2FA activée (saisie du code) ;
 * - `enrollment` : rôle ADMIN seulement (`admin/security/status|enrollment*|end`).
 */
export type AdminStage = 'full' | 'verify' | 'enrollment';

export const ADMIN_STAGE_KEY = 'raijin:admin-stage';
export const ADMIN_THROTTLER = 'admin';
const WINDOW_MS = 60_000;

/** Contexte posé par `AdminGuard` (session admin active pour l'étape `full`). */
export interface AdminContext {
  readonly userId: string;
  readonly sessionId: string;
}

type AdminRequest = Request & { auth?: AuthContext; admin?: AdminContext };

/**
 * Garde de l'espace admin (docs/ARCHITECTURE.md §14.3), après `AuthGuard` :
 * 1. rôle **relu en base** ; pas ADMIN (ou compte suspendu) → **404 `NOT_FOUND`** (espace invisible) ;
 * 2. throttler `admin` par utilisateur ;
 * 3. 2FA non activée → 403 `ADMIN_2FA_ENROLLMENT_REQUIRED` (sauf étape `enrollment`) ;
 * 4. session non vérifiée → 403 `ADMIN_2FA_REQUIRED` ; inactivité ou durée maximale dépassée → 403
 *    `ADMIN_SESSION_EXPIRED` (colonnes remises à null) ; sinon `adminLastSeenAt` mis à jour (au plus une fois par minute).
 * Toutes les réponses : `Cache-Control: no-store`. Codes en 403, jamais 401 (pas de refresh côté front).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Inject(ThrottlerStorage) private readonly throttler: ThrottlerStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Horloge (remplacée dans les tests unitaires). */
  now(): Date {
    return new Date();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<AdminRequest>();
    http.getResponse<Response>().setHeader('Cache-Control', 'no-store');
    const auth = req.auth;
    if (!auth) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    const stage = this.reflector.getAllAndOverride<AdminStage | undefined>(ADMIN_STAGE_KEY, [context.getHandler(), context.getClass()]) ?? 'full';

    const user = await this.prisma.user.findUnique({
      where: { id: auth.userId },
      select: { role: true, suspendedAt: true, totpSecret: { select: { enabledAt: true } } },
    });
    if (!user || user.role !== 'ADMIN' || user.suspendedAt) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);

    const limit = this.config.admin.perMinute;
    const record = await this.throttler.increment(`${ADMIN_THROTTLER}:u:${auth.userId}`, WINDOW_MS, limit, 0, ADMIN_THROTTLER);
    if (record.totalHits > limit) throw new ApiException('RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);

    if (stage === 'enrollment') return true;
    if (!user.totpSecret?.enabledAt) throw ApiException.admin('ADMIN_2FA_ENROLLMENT_REQUIRED', HttpStatus.FORBIDDEN);
    if (stage === 'verify') return true;

    const session = await this.prisma.session.findUnique({
      where: { id: auth.sessionId },
      select: { adminVerifiedAt: true, adminLastSeenAt: true },
    });
    const now = this.now();
    const state = adminSessionState(session ?? { adminVerifiedAt: null, adminLastSeenAt: null }, this.config.admin, now);
    if (state === 'unverified') throw ApiException.admin('ADMIN_2FA_REQUIRED', HttpStatus.FORBIDDEN);
    if (state === 'expired') {
      await this.prisma.session.updateMany({ where: { id: auth.sessionId }, data: { adminVerifiedAt: null, adminLastSeenAt: null } });
      throw ApiException.admin('ADMIN_SESSION_EXPIRED', HttpStatus.FORBIDDEN);
    }
    await this.prisma.session.updateMany({
      where: {
        id: auth.sessionId,
        adminVerifiedAt: { not: null },
        OR: [{ adminLastSeenAt: null }, { adminLastSeenAt: { lt: new Date(now.getTime() - ADMIN_LAST_SEEN_THROTTLE_MS) } }],
      },
      data: { adminLastSeenAt: now },
    });
    req.admin = { userId: auth.userId, sessionId: auth.sessionId };
    return true;
  }
}

/**
 * À poser sur **chaque** contrôleur `admin/*` : `AuthGuard` puis `AdminGuard`. `stage` assouplit l'exigence pour les
 * seules routes de 2FA (`admin/security/*`).
 */
export function AdminRoute(stage: AdminStage = 'full'): ClassDecorator & MethodDecorator {
  return applyDecorators(SetMetadata(ADMIN_STAGE_KEY, stage), UseGuards(AuthGuard, AdminGuard));
}

/** Étape d'une méthode qui diffère de celle de son contrôleur. */
export const AdminStageOverride = (stage: AdminStage) => SetMetadata(ADMIN_STAGE_KEY, stage);
