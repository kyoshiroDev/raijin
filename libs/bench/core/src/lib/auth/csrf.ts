import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BENCH_CSRF_HEADER } from '@raijin/bench-contracts';
import type { Request } from 'express';
import type { BenchConfig } from '../config/bench-config';
import { BENCH_CONFIG } from '../config/tokens';
import { BenchException } from '../http/bench-exception';
import { BENCH_SKIP_CSRF } from '../http/decorators';
import { hmac, randomToken, safeEqual } from '../security/crypto';
import { BenchCookies } from './cookies';
import { benchSessionOf } from './session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Jeton CSRF double-submit signé et lié à la session : `nonce.HMAC(secret, csrf:nonce.sessionId)`. */
@Injectable()
export class BenchCsrfService {
  constructor(@Inject(BENCH_CONFIG) private readonly config: BenchConfig) {}

  issue(sessionId: string): string {
    const nonce = randomToken(18);
    return `${nonce}.${this.sign(nonce, sessionId)}`;
  }

  verify(token: string, sessionId: string): boolean {
    const [nonce, signature, extra] = token.split('.');
    if (!nonce || !signature || extra !== undefined) return false;
    return safeEqual(signature, this.sign(nonce, sessionId));
  }

  private sign(nonce: string, sessionId: string): string {
    return hmac(this.config.auth.sessionSecret, `csrf:${nonce}.${sessionId}`);
  }
}

/**
 * Garde des écritures (POST, PUT, PATCH, DELETE), après la garde de session :
 * 1. `Origin` présent et dans `BENCH_ALLOWED_ORIGINS` (y compris pour la connexion) ;
 * 2. en-tête `X-CSRF-Token` identique au cookie CSRF ;
 * 3. signature valide pour la session courante. Refus : 403 `AUTH_CSRF_INVALID`.
 */
@Injectable()
export class BenchCsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly csrf: BenchCsrfService,
    private readonly cookies: BenchCookies,
    @Inject(BENCH_CONFIG) private readonly config: BenchConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !this.config.allowedOrigins.includes(origin)) throw BenchException.csrf();
    if (this.reflector.getAllAndOverride<boolean>(BENCH_SKIP_CSRF, [context.getHandler(), context.getClass()])) return true;
    const header = req.headers[BENCH_CSRF_HEADER.toLowerCase()];
    const cookie = this.cookies.read(req, 'csrf');
    const session = benchSessionOf(req);
    if (typeof header !== 'string' || !cookie || !session || !safeEqual(header, cookie) || !this.csrf.verify(header, session.sessionId)) throw BenchException.csrf();
    return true;
  }
}
