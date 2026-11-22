import { type AuthSession, type PublicUser } from '@raijin/shared-contracts';

/** Données de test conformes aux contrats (utilisées par les specs de data-access et des features). */
export function fakeUser(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: '0193a3b2-7c1d-7e4f-9a2b-3c4d5e6f7a8b',
    email: 'kenji@exemple.fr',
    emailVerified: true,
    plan: 'FREE',
    role: 'USER',
    trial: { status: 'none', startedAt: null, endsAt: null },
    createdAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

export function fakeSession(overrides: Partial<PublicUser> = {}, csrfToken = 'csrf-session-token-0123456789abcdef'): AuthSession {
  return {
    user: fakeUser(overrides),
    accessTokenExpiresAt: '2026-11-22T12:15:00.000Z',
    csrfToken,
  };
}

export const CSRF_ANON = 'csrf-anonymous-token-0123456789abcdef';
