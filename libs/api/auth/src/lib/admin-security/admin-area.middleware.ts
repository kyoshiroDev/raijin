import { HttpStatus, Injectable, type NestMiddleware } from '@nestjs/common';
import { defaultMessage } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import type { NextFunction, Request, Response } from 'express';
import { AccessTokenService } from '../services/access-token.service';

/** Chemins de l'espace admin (relatifs au préfixe global `api/v1`). */
export const ADMIN_AREA_ROUTES = 'admin/*path';

/**
 * Espace admin invisible (audit phase 6 bis, m3) : sur `admin/*`, **avant** le throttler, la garde CSRF et
 * `AuthGuard`, toute requête qui ne provient pas d'un compte ADMIN (relu en base, non suspendu) reçoit 404
 * `NOT_FOUND` — visiteur anonyme, jeton invalide, compte USER ou suspendu — au lieu de 401 / 403 / 429 qui
 * révéleraient l'existence des routes. Un ADMIN (jeton signé, même expiré) passe : il garde ses 401 (refresh),
 * 403 (CSRF, 2FA, session admin) et 429 habituels. Les pré-requêtes CORS (`OPTIONS`) ne sont pas concernées.
 */
@Injectable()
export class AdminAreaMiddleware implements NestMiddleware {
  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.method === 'OPTIONS') return next();
    const userId = this.accessTokens.readSubject(req);
    const user = userId ? await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, suspendedAt: true } }) : null;
    if (user?.role === 'ADMIN' && !user.suspendedAt) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.status(HttpStatus.NOT_FOUND).json({ code: 'NOT_FOUND', message: defaultMessage('NOT_FOUND') });
  }
}
