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
 * - aucun cookie d'access : 401 `UNAUTHORIZED` → pas de refresh sur cette requête. Le front n'y arrive
 *   pas avec un refresh valide : au démarrage, `GET /auth/session` répond 401 `AUTH_SESSION_EXPIRED`
 *   quand seul le cookie de refresh reste (contrat `SessionState`), le front rafraîchit de façon
 *   transparente et l'utilisateur reste connecté. Sans aucun cookie de session : visiteur anonyme ;
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

/**
 * Authentification facultative (routes ouvertes aux visiteurs, ex. `POST /analyses`) :
 * - aucun cookie d'access : visiteur anonyme, la requête continue sans `auth` ;
 * - cookie présent mais expiré, invalide ou session révoquée : 401 `AUTH_SESSION_EXPIRED`, pour que
 *   le front rafraîchisse la session au lieu de consommer en silence le quota anonyme ;
 * - cookie valide : `auth` posé comme avec `AuthGuard`.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly required: AuthGuard, private readonly cookies: AuthCookies) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!this.cookies.read(req, 'access')) return true;
    return this.required.canActivate(context);
  }
}

/** `@OptionalAuth() auth: AuthContext | null` (route protégée par `OptionalAuthGuard`). */
export const OptionalAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext | null =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth ?? null,
);
