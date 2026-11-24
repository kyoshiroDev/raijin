import { HttpStatus, Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { APP_CONFIG, defaultMessage, throttleTracker, type AppConfig } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import type { NextFunction, Request, Response } from 'express';
import { AccessTokenService } from '../services/access-token.service';

/** Chemins de l'espace admin (relatifs au préfixe global `api/v1`). */
export const ADMIN_AREA_ROUTES = 'admin/*path';

/** Compteur propre au middleware (fenêtre 1 min par préfixe d'IP), distinct des compteurs de la garde globale. */
export const ADMIN_AREA_THROTTLER = 'admin-area';
const ADMIN_AREA_TTL_MS = 60_000;

/**
 * Espace admin invisible (audit phase 6 bis, m3) : sur `admin/*`, **avant** le throttler, la garde CSRF et
 * `AuthGuard`, toute requête qui ne provient pas d'un compte ADMIN (relu en base, non suspendu) reçoit 404
 * `NOT_FOUND` — visiteur anonyme, jeton invalide, compte USER ou suspendu — au lieu de 401 / 403 / 429 qui
 * révéleraient l'existence des routes. Un ADMIN (jeton signé, même expiré) passe : il garde ses 401 (refresh),
 * 403 (CSRF, 2FA, session admin) et 429 habituels. Les pré-requêtes CORS (`OPTIONS`) ne sont pas concernées.
 *
 * Audit 6 bis n2 : le middleware passe avant la garde de rate limiting, il compte donc lui-même les requêtes
 * (`RATE_LIMIT_PER_MINUTE` par préfixe d'IP, stockage du throttler) **avant** de vérifier le jeton et de lire la base.
 * Au-delà : 404 sans lecture en base, pour tout le monde (un 429 révélerait l'existence des routes).
 */
@Injectable()
export class AdminAreaMiddleware implements NestMiddleware {
  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly prisma: PrismaService,
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.method === 'OPTIONS') return next();
    if (await this.throttled(req)) return this.notFound(res);
    const userId = this.accessTokens.readSubject(req);
    const user = userId ? await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, suspendedAt: true } }) : null;
    if (user?.role === 'ADMIN' && !user.suspendedAt) return next();
    this.notFound(res);
  }

  private async throttled(req: Request): Promise<boolean> {
    const limit = this.config.rateLimit.perMinute;
    const key = `${ADMIN_AREA_THROTTLER}:${throttleTracker({ ip: req.ip })}`;
    const record = await this.storage.increment(key, ADMIN_AREA_TTL_MS, limit, ADMIN_AREA_TTL_MS, ADMIN_AREA_THROTTLER);
    return record.isBlocked || record.totalHits > limit;
  }

  private notFound(res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    res.status(HttpStatus.NOT_FOUND).json({ code: 'NOT_FOUND', message: defaultMessage('NOT_FOUND') });
  }
}
