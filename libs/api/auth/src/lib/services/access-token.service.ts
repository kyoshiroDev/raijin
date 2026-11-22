import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_CONFIG, AuthCookies, type AppConfig } from '@raijin/api-core';
import type { Role } from '@raijin/shared-contracts';
import type { Request } from 'express';

export const ACCESS_TOKEN_ISSUER = 'raijin-api';
export const ACCESS_TOKEN_AUDIENCE = 'raijin-app';

/** Contenu minimal de l'access token : le plan et les quotas sont toujours relus en base. */
export interface AccessTokenPayload {
  readonly sub: string;
  readonly sid: string;
  readonly role: Role;
}

export interface VerifiedAccessToken extends AccessTokenPayload {
  readonly expiresAt: Date;
}

/** Access token JWT HS256 court (JWT_ACCESS_TTL), signé par JWT_ACCESS_SECRET. */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly cookies: AuthCookies,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  sign(payload: AccessTokenPayload): { token: string; expiresAt: Date } {
    const ttlSeconds = Math.max(1, Math.floor(this.config.auth.accessTtlMs / 1000));
    const token = this.jwt.sign(
      { sub: payload.sub, sid: payload.sid, role: payload.role },
      {
        secret: this.config.auth.accessSecret,
        algorithm: 'HS256',
        expiresIn: ttlSeconds,
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
      },
    );
    const decoded = this.jwt.decode<{ exp: number }>(token);
    return { token, expiresAt: new Date(decoded.exp * 1000) };
  }

  /** Vérifie la signature (et l'expiration sauf `ignoreExpiration`) ; `null` si invalide. */
  verify(token: string, options: { ignoreExpiration?: boolean } = {}): VerifiedAccessToken | null {
    try {
      const payload = this.jwt.verify<Record<string, unknown>>(token, {
        secret: this.config.auth.accessSecret,
        algorithms: ['HS256'],
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        ignoreExpiration: options.ignoreExpiration ?? false,
      });
      const { sub, sid, role, exp } = payload;
      if (typeof sub !== 'string' || typeof sid !== 'string' || typeof exp !== 'number') return null;
      if (role !== 'USER' && role !== 'ADMIN') return null;
      return { sub, sid, role, expiresAt: new Date(exp * 1000) };
    } catch {
      return null;
    }
  }

  /** Access token valide (non expiré) de la requête. */
  fromRequest(req: Request): VerifiedAccessToken | null {
    const token = this.cookies.read(req, 'access');
    return token ? this.verify(token) : null;
  }

  /** `sid` d'un access token signé, même expiré (garde CSRF, refresh, logout). */
  readSessionId(req: Request): string | null {
    const token = this.cookies.read(req, 'access');
    return token ? (this.verify(token, { ignoreExpiration: true })?.sid ?? null) : null;
  }
}
