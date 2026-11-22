import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ApiException, AuthCookies } from '@raijin/api-core';
import type { Role } from '@raijin/shared-contracts';
import type { Request } from 'express';
import { AccessTokenService } from '../services/access-token.service';
import { SessionService } from '../services/session.service';

/** Identité de la requête authentifiée (posée par `AuthGuard`). */
export interface AuthContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: Role;
  readonly accessTokenExpiresAt: Date;
}

type AuthenticatedRequest = Request & { auth?: AuthContext };

/**
 * Exige un access token valide (cookie httpOnly) et une session active en base
 * (révocation immédiate après déconnexion ou réinitialisation).
 * - aucun cookie d'access (jamais connecté, ou déconnecté) : 401 `UNAUTHORIZED` → pas de refresh ;
 * - cookie présent mais expiré, invalide ou session révoquée : 401 `AUTH_SESSION_EXPIRED` → refresh.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly sessions: SessionService,
    private readonly cookies: AuthCookies,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!this.cookies.read(req, 'access')) throw new ApiException('UNAUTHORIZED', HttpStatus.UNAUTHORIZED);
    const token = this.accessTokens.fromRequest(req);
    if (!token || !(await this.sessions.isActive(token.sid, token.sub))) {
      throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
    }
    req.auth = {
      userId: token.sub,
      sessionId: token.sid,
      role: token.role,
      accessTokenExpiresAt: token.expiresAt,
    };
    return true;
  }
}

/** `@CurrentAuth() auth: AuthContext` (route protégée par `AuthGuard`). */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext => {
  const auth = context.switchToHttp().getRequest<AuthenticatedRequest>().auth;
  if (!auth) throw ApiException.auth('AUTH_SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);
  return auth;
});
