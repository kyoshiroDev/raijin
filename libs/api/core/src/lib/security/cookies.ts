import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';

/**
 * Chemin du cookie de refresh : `/`, imposé par le préfixe `__Host-` (aucun Domain possible, donc
 * aucun sous-domaine, ex. l'environnement dev, ne peut déposer un refresh lu par la prod).
 */
export const REFRESH_COOKIE_PATH = '/';

/** Ancien chemin du refresh (`__Secure-rj_rt`, avant le passage en `__Host-`) : effacé à la rotation. */
export const LEGACY_REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * Ancien nom du refresh en mode Secure : accepté une dernière fois (jusqu'à `auth.legacyRefreshUntil`)
 * puis effacé (migration douce). À retirer du code après cette date (docs/SECURITY.md, menace 3).
 */
export const LEGACY_SECURE_REFRESH_COOKIE = '__Secure-rj_rt';

export interface CookieNames {
  readonly access: string;
  readonly refresh: string;
  readonly csrf: string;
}

/**
 * Noms des cookies (docs/ARCHITECTURE.md §8.4) : préfixe `__Host-` quand `COOKIE_SECURE=true`
 * (production), noms simples en dev sur http://localhost.
 */
export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { access: '__Host-rj_at', refresh: '__Host-rj_rt', csrf: '__Host-rj_csrf' }
    : { access: 'rj_at', refresh: 'rj_rt', csrf: 'rj_csrf' };
}

/** Refresh présenté par la requête (`POST /auth/refresh`, logout, état de session). */
export type PresentedRefresh =
  /** Nom de refresh répété dans l'en-tête `Cookie` brut : injection probable depuis un sous-domaine. */
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'none' }
  /** `legacy` : lu sous l'ancien nom `__Secure-rj_rt`. */
  | { readonly kind: 'token'; readonly token: string; readonly legacy: boolean };

const MAX_COOKIE_VALUE = 4096;

/** Noms de cookies de l'en-tête brut, dans l'ordre (cookie-parser ne garde que la première occurrence). */
function rawCookieNames(req: Request): string[] {
  const header = req.headers?.cookie;
  const raw = Array.isArray(header) ? header.join(';') : (header ?? '');
  return raw
    .split(';')
    .map((part) => {
      const index = part.indexOf('=');
      return (index === -1 ? part : part.slice(0, index)).trim();
    })
    .filter((name) => name.length > 0);
}

/** Chemins où un ancien `__Secure-rj_rt` a pu être déposé (le nôtre, ou celui d'un cookie injecté). */
const LEGACY_REFRESH_CLEAR_PATHS = [LEGACY_REFRESH_COOKIE_PATH, '/api/v1/auth/refresh', '/'] as const;

/** Pose et lit les cookies de session : tous HttpOnly, SameSite=Lax, sans Domain. */
@Injectable()
export class AuthCookies {
  readonly names: CookieNames;
  /** Ancien nom du refresh (mode Secure uniquement ; en dev le nom `rj_rt` est inchangé, seul le chemin change). */
  readonly legacyRefresh: string | null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.names = cookieNames(config.auth.cookieSecure);
    this.legacyRefresh = config.auth.cookieSecure ? LEGACY_SECURE_REFRESH_COOKIE : null;
  }

  /** L'ancien `__Secure-rj_rt` est-il encore accepté (fenêtre de migration) ? */
  private legacyAccepted(): boolean {
    return this.legacyRefresh !== null && Date.now() < this.config.auth.legacyRefreshUntil.getTime();
  }

  /** L'en-tête `Cookie` brut contient-il l'ancien nom du refresh (accepté ou non) ? */
  hasLegacyRefresh(req: Request): boolean {
    return this.legacyRefresh !== null && rawCookieNames(req).includes(this.legacyRefresh);
  }

  /**
   * Efface l'ancien `__Secure-rj_rt` partout où il a pu être posé : sans Domain et avec
   * `Domain=<domaine parent>` (dérivé de API_URL, jamais d'un en-tête), sur les chemins connus.
   * Sans cela, un cookie injecté par un sous-domaine provoquerait un 401 à chaque visite.
   */
  clearLegacyRefreshEverywhere(res: Response): void {
    if (!this.legacyRefresh) return;
    const parent = this.config.auth.cookieParentDomain;
    const domains: (string | undefined)[] = parent ? [undefined, parent] : [undefined];
    for (const domain of domains) {
      for (const path of LEGACY_REFRESH_CLEAR_PATHS) {
        res.clearCookie(this.legacyRefresh, { ...this.base(path), ...(domain ? { domain } : {}) });
      }
    }
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

  /** Efface le refresh de l'ancien chemin (ancien nom en Secure, `rj_rt` sur `/api/v1/auth` en dev). */
  private clearLegacyRefresh(res: Response): void {
    res.clearCookie(this.legacyRefresh ?? this.names.refresh, this.base(LEGACY_REFRESH_COOKIE_PATH));
  }

  /**
   * Pose access + refresh. Le cookie d'access vit aussi longtemps que la session : le JWT
   * expire au bout de JWT_ACCESS_TTL, mais son `sid` reste lisible pour la garde CSRF du refresh.
   * L'ancien refresh (ancien nom ou ancien chemin) est effacé à chaque pose : migration douce.
   */
  setSession(res: Response, accessToken: string, refreshToken: string): void {
    const maxAge = this.config.auth.refreshTtlMs;
    this.clearLegacyRefresh(res);
    res.cookie(this.names.access, accessToken, this.base('/', maxAge));
    res.cookie(this.names.refresh, refreshToken, this.base(REFRESH_COOKIE_PATH, maxAge));
  }

  setCsrf(res: Response, token: string): void {
    res.cookie(this.names.csrf, token, this.base('/', this.config.auth.refreshTtlMs));
  }

  clearSession(res: Response): void {
    this.clearLegacyRefresh(res);
    res.clearCookie(this.names.access, this.base('/'));
    res.clearCookie(this.names.refresh, this.base(REFRESH_COOKIE_PATH));
  }

  read(req: Request, name: keyof CookieNames): string | null {
    return this.readNamed(req, this.names[name]);
  }

  /**
   * Refresh de la requête. Refusé (`duplicate`) si l'en-tête `Cookie` brut contient plusieurs fois
   * le nom du refresh (ou l'ancien nom, pendant la migration) : un cookie injecté par un sous-domaine passerait sinon en
   * premier. Le nouveau nom prime ; l'ancien `__Secure-rj_rt` n'est lu qu'en son absence.
   */
  readRefresh(req: Request): PresentedRefresh {
    const names = rawCookieNames(req);
    const count = (target: string) => names.filter((name) => name === target).length;
    if (count(this.names.refresh) > 1) return { kind: 'duplicate' };
    const legacyName = this.legacyAccepted() ? this.legacyRefresh : null;
    if (legacyName && count(legacyName) > 1) return { kind: 'duplicate' };
    const current = this.readNamed(req, this.names.refresh);
    if (current) return { kind: 'token', token: current, legacy: false };
    // Après `legacyRefreshUntil`, l'ancien nom est ignoré (seulement effacé par le contrôleur).
    const legacy = legacyName ? this.readNamed(req, legacyName) : null;
    return legacy ? { kind: 'token', token: legacy, legacy: true } : { kind: 'none' };
  }

  private readNamed(req: Request, cookieName: string): string | null {
    const cookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
    const value = cookies?.[cookieName];
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_COOKIE_VALUE ? value : null;
  }
}
