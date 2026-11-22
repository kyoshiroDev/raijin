import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';

/** Chemin du cookie de refresh : envoyé uniquement aux routes d'auth. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface CookieNames {
  readonly access: string;
  readonly refresh: string;
  readonly csrf: string;
}

/**
 * Noms des cookies (docs/ARCHITECTURE.md §8.4) : préfixes `__Host-` / `__Secure-` quand
 * `COOKIE_SECURE=true` (production), noms simples en dev sur http://localhost.
 */
export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { access: '__Host-rj_at', refresh: '__Secure-rj_rt', csrf: '__Host-rj_csrf' }
    : { access: 'rj_at', refresh: 'rj_rt', csrf: 'rj_csrf' };
}

/** Pose et lit les cookies de session : tous HttpOnly, SameSite=Lax, sans Domain. */
@Injectable()
export class AuthCookies {
  readonly names: CookieNames;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.names = cookieNames(config.auth.cookieSecure);
  }

  private base(path: string, maxAge?: number): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.auth.cookieSecure,
      sameSite: 'lax',
      path,
      ...(maxAge === undefined ? {} : { maxAge }),
    };
  }

  /**
   * Pose access + refresh. Le cookie d'access vit aussi longtemps que la session : le JWT
   * expire au bout de JWT_ACCESS_TTL, mais son `sid` reste lisible pour la garde CSRF du refresh.
   */
  setSession(res: Response, accessToken: string, refreshToken: string): void {
    const maxAge = this.config.auth.refreshTtlMs;
    res.cookie(this.names.access, accessToken, this.base('/', maxAge));
    res.cookie(this.names.refresh, refreshToken, this.base(REFRESH_COOKIE_PATH, maxAge));
  }

  setCsrf(res: Response, token: string): void {
    res.cookie(this.names.csrf, token, this.base('/', this.config.auth.refreshTtlMs));
  }

  clearSession(res: Response): void {
    res.clearCookie(this.names.access, this.base('/'));
    res.clearCookie(this.names.refresh, this.base(REFRESH_COOKIE_PATH));
  }

  read(req: Request, name: keyof CookieNames): string | null {
    const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
    const value = cookies?.[this.names[name]];
    return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null;
  }
}
