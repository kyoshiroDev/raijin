import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_HEADER } from '@raijin/shared-contracts';
import type { Request } from 'express';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { ApiException } from '../errors/api-exception';
import { AuthCookies } from './cookies';
import { hmac, randomToken, safeEqual } from './crypto';

const ANONYMOUS = 'anon';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const SKIP_CSRF = 'raijin:skip-csrf';

/** Exempte une route de la garde CSRF (réservé aux webhooks signés, ex. Stripe en phase 6). */
export const SkipCsrf = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_CSRF, true);

/** Lit l'identifiant de session (`sid`) d'une requête, ou `null`. */
export type SessionIdResolver = (req: Request) => string | null;

/**
 * Point d'enregistrement du lecteur de `sid` : `api-auth` y inscrit le sien au démarrage
 * (access token signé, même expiré). Sans lecteur, toutes les requêtes sont anonymes.
 */
@Injectable()
export class SessionIdResolverRegistry {
  private resolver: SessionIdResolver = () => null;

  register(resolver: SessionIdResolver): void {
    this.resolver = resolver;
  }

  resolve(req: Request): string | null {
    return this.resolver(req);
  }
}

/**
 * Jetons CSRF double-submit signés (docs/ARCHITECTURE.md §8.5) : `nonce.HMAC(COOKIE_SECRET, nonce.sid)`.
 * Un jeton émis pour une session ne vaut que pour elle ; avant connexion, il est lié à « anon ».
 */
@Injectable()
export class CsrfService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  issue(sessionId: string | null): string {
    const nonce = randomToken(18);
    return `${nonce}.${this.sign(nonce, sessionId)}`;
  }

  verify(token: string, sessionId: string | null): boolean {
    const [nonce, signature, extra] = token.split('.');
    if (!nonce || !signature || extra !== undefined) return false;
    return safeEqual(signature, this.sign(nonce, sessionId));
  }

  private sign(nonce: string, sessionId: string | null): string {
    return hmac(this.config.auth.cookieSecret, `${nonce}.${sessionId ?? ANONYMOUS}`);
  }
}

/**
 * Garde globale des mutations (POST, PUT, PATCH, DELETE) :
 * 1. en-tête `Origin` présent et autorisé ;
 * 2. en-tête `X-CSRF-Token` identique au cookie CSRF (httpOnly) ;
 * 3. signature valide pour la session courante si un sid est lu, anonyme sinon.
 * Refus : 403 `AUTH_CSRF_INVALID`.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly csrf: CsrfService,
    private readonly cookies: AuthCookies,
    private readonly sessions: SessionIdResolverRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !this.config.allowedOrigins.includes(origin)) throw this.refuse();

    const header = req.headers[CSRF_HEADER.toLowerCase()];
    const cookie = this.cookies.read(req, 'csrf');
    if (typeof header !== 'string' || !cookie || !safeEqual(header, cookie)) throw this.refuse();

    // Session lue (access token signé, même expiré) : seul un jeton lié à ce sid est accepté.
    // Sans session : jeton anonyme uniquement.
    const sessionId = this.sessions.resolve(req);
    if (this.csrf.verify(header, sessionId)) return true;
    throw this.refuse();
  }

  private refuse(): ApiException {
    return ApiException.auth('AUTH_CSRF_INVALID', HttpStatus.FORBIDDEN);
  }
}
