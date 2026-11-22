import { AUTH_EMAIL_LINK_PATHS, AUTH_EMAIL_TOKEN_PARAM } from './links';
import { deleteAccountRequestSchema } from './requests';
import { magicLinkSessionSchema } from './session';
import { relativePathSchema } from './common';

describe('contrats ajoutés en phase 2 (API)', () => {
  it('les chemins des liens e-mail sont des chemins internes valides', () => {
    for (const path of Object.values(AUTH_EMAIL_LINK_PATHS)) {
      expect(relativePathSchema.safeParse(path).success).toBe(true);
    }
    expect(AUTH_EMAIL_TOKEN_PARAM).toBe('token');
  });

  it('suppression de compte : mot de passe requis', () => {
    expect(deleteAccountRequestSchema.safeParse({ password: 'x' }).success).toBe(true);
    expect(deleteAccountRequestSchema.safeParse({ password: '' }).success).toBe(false);
    expect(deleteAccountRequestSchema.safeParse({}).success).toBe(false);
  });

  it('session du lien magique : redirectPath relatif ou null', () => {
    const base = {
      user: {
        id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
        email: 'a@b.fr',
        emailVerified: true,
        plan: 'FREE',
        role: 'USER',
        trial: { status: 'none', startedAt: null, endsAt: null },
        createdAt: '2026-11-22T10:00:00.000Z',
      },
      accessTokenExpiresAt: '2026-11-22T10:15:00.000Z',
      csrfToken: 'A'.repeat(40),
    };
    expect(magicLinkSessionSchema.safeParse({ ...base, redirectPath: '/suivis' }).success).toBe(true);
    expect(magicLinkSessionSchema.safeParse({ ...base, redirectPath: null }).success).toBe(true);
    expect(magicLinkSessionSchema.safeParse({ ...base, redirectPath: '//evil.example' }).success).toBe(false);
  });
});
