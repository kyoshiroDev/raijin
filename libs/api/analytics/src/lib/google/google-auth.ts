import { createSign } from 'node:crypto';
import { GoogleApiError, postJson, type FetchFn } from './google-http';
import type { ServiceAccountKey } from './service-account';

/** Point d'échange OAuth 2.0 des comptes de service (hôte fixe). */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Portées en lecture seule, rien d'autre (docs/ARCHITECTURE.md §14.6). */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/webmasters.readonly'] as const;
/** Le jeton est renouvelé 5 min avant son expiration. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const JWT_LIFETIME_S = 3_600;

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** JWT RS256 signé avec `node:crypto` (assertion du flux « JWT bearer » des comptes de service). */
export function signServiceAccountJwt(key: ServiceAccountKey, nowMs: number, scopes: readonly string[] = GOOGLE_SCOPES): string {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iss: key.clientEmail, scope: scopes.join(' '), aud: GOOGLE_TOKEN_URL, iat, exp: iat + JWT_LIFETIME_S }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(key.privateKey).toString('base64url')}`;
}

/**
 * Jeton d'accès Google gardé **en mémoire** jusqu'à 5 min avant son expiration (jamais en Redis, jamais journalisé).
 * Un refus de Google à l'échange (clé révoquée, compte supprimé) devient `auth_failed`.
 */
export class GoogleTokenProvider {
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly fetchFn: FetchFn,
    private readonly now: () => number = Date.now,
  ) {}

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.token.value;
    this.pending ??= this.exchange().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const assertion = signServiceAccountJwt(this.key, this.now());
    const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
    let body: unknown;
    try {
      body = await postJson(this.fetchFn, GOOGLE_TOKEN_URL, form, { 'Content-Type': 'application/x-www-form-urlencoded' });
    } catch (error) {
      // 400 invalid_grant (clé révoquée) ou 401 : la clé est refusée.
      if (error instanceof GoogleApiError && error.status !== null && error.status >= 400 && error.status < 500) throw new GoogleApiError('auth_failed', error.status);
      throw error;
    }
    const record = (body ?? {}) as Record<string, unknown>;
    const value = record['access_token'];
    const expiresIn = record['expires_in'];
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new GoogleApiError('auth_failed', null);
    const lifetime = typeof expiresIn === 'number' && expiresIn > 0 ? Math.min(expiresIn, JWT_LIFETIME_S) : JWT_LIFETIME_S;
    this.token = { value, expiresAt: this.now() + lifetime * 1000 };
    return value;
  }
}
