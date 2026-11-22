import { HttpErrorResponse } from '@angular/common/http';
import { AUTH_ERROR_MESSAGES, CSRF_HEADER } from '@raijin/shared-contracts';
import { CSRF_HEADER_NAME, hasErrorCode, rawErrorCode } from './error-code';
import { apiErrorCode, isAuthError, toClientError } from './api-error';
import { isApiUrl, isMutation } from './api-url';

const httpError = (status: number, error: unknown = null) => new HttpErrorResponse({ status, error });

describe('toClientError', () => {
  it('reprend le message français d’un code d’auth (jamais le message brut de l’API)', () => {
    const error = toClientError(httpError(401, { code: 'AUTH_INVALID_CREDENTIALS', message: 'raw server text' }));
    expect(error).toEqual({ code: 'AUTH_INVALID_CREDENTIALS', message: AUTH_ERROR_MESSAGES.AUTH_INVALID_CREDENTIALS, status: 401 });
  });

  it('traduit les codes génériques', () => {
    expect(toClientError(httpError(429, { code: 'RATE_LIMITED', message: 'x' })).message).toContain('Patiente');
  });

  it('déduit le code du statut quand le corps est hors format', () => {
    expect(toClientError(httpError(0)).code).toBe('NETWORK_ERROR');
    expect(toClientError(httpError(500, '<html>')).code).toBe('INTERNAL_ERROR');
    expect(toClientError(httpError(503)).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(toClientError(httpError(404)).code).toBe('NOT_FOUND');
    expect(toClientError(httpError(422)).code).toBe('VALIDATION_ERROR');
  });

  it('gère une erreur non HTTP', () => {
    expect(toClientError(new Error('boom')).code).toBe('INTERNAL_ERROR');
    expect(apiErrorCode(new Error('boom'))).toBeNull();
  });

  it('reconnaît les codes d’auth', () => {
    expect(isAuthError('AUTH_TOKEN_INVALID')).toBe(true);
    expect(isAuthError('RATE_LIMITED')).toBe(false);
  });
});

describe('isApiUrl / isMutation', () => {
  it('ne cible que l’API Raijin', () => {
    expect(isApiUrl('/api/v1/auth/login', '/api/v1')).toBe(true);
    expect(isApiUrl('/api/v1', '/api/v1/')).toBe(true);
    expect(isApiUrl('/api/v10/x', '/api/v1')).toBe(false);
    expect(isApiUrl('https://evil.example/api/v1/x', '/api/v1')).toBe(false);
    expect(isApiUrl('https://api.raijinshield.com/api/v1/x', 'https://api.raijinshield.com/api/v1')).toBe(true);
  });

  it('distingue les mutations', () => {
    expect(isMutation('POST')).toBe(true);
    expect(isMutation('delete')).toBe(true);
    expect(isMutation('GET')).toBe(false);
    expect(isMutation('HEAD')).toBe(false);
  });
});

describe('error-code (sans Zod, pour les intercepteurs)', () => {
  it('lit le code brut et reste aligné sur les contrats', () => {
    expect(CSRF_HEADER_NAME).toBe(CSRF_HEADER);
    const error = httpError(401, { code: 'AUTH_SESSION_EXPIRED', message: 'x' });
    expect(rawErrorCode(error)).toBe('AUTH_SESSION_EXPIRED');
    expect(hasErrorCode(error, 'UNAUTHORIZED', 'AUTH_SESSION_EXPIRED')).toBe(true);
    expect(rawErrorCode(httpError(401, 'texte'))).toBeNull();
    expect(rawErrorCode(httpError(401, { code: 42 }))).toBeNull();
    expect(rawErrorCode(new Error('x'))).toBeNull();
  });
});
