import {
  AUTH_ERROR_CODES,
  AUTH_ERROR_MESSAGES,
  CSRF_HEADER,
  PASSWORD_RULES,
  apiErrorSchema,
  authSessionSchema,
  changePasswordRequestSchema,
  csrfResponseSchema,
  emailSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  magicLinkRequestSchema,
  magicLinkVerifyRequestSchema,
  messageResponseSchema,
  newPasswordSchema,
  publicUserSchema,
  registerRequestSchema,
  relativePathSchema,
  resendVerificationRequestSchema,
  resetPasswordRequestSchema,
  sessionStateSchema,
  signupAttributionSchema,
  verifyEmailRequestSchema,
} from '../../index';

const TOKEN = 'a'.repeat(43);
const PASSWORD = 'une phrase de passe solide';
const NOW = '2026-11-22T10:00:00.000Z';

const user = {
  id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  email: 'rai@example.com',
  emailVerified: true,
  plan: 'PRO',
  role: 'USER',
  trial: { status: 'active', startedAt: NOW, endsAt: '2026-11-29T10:00:00.000Z' },
  createdAt: NOW,
};

describe('emailSchema', () => {
  it('retire les espaces et met en minuscules', () => {
    expect(emailSchema.parse('  Rai@Example.COM ')).toBe('rai@example.com');
  });

  it('refuse une adresse invalide ou trop longue', () => {
    expect(emailSchema.safeParse('rai@').success).toBe(false);
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@x.fr`).success).toBe(false);
  });
});

describe('règles de mot de passe', () => {
  it('impose la longueur minimale et maximale', () => {
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_RULES.minLength - 1)).success).toBe(false);
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_RULES.minLength)).success).toBe(true);
    expect(newPasswordSchema.safeParse('a'.repeat(PASSWORD_RULES.maxLength + 1)).success).toBe(false);
  });

  it('refuse un mot de passe fait d’espaces et ne le retaille pas', () => {
    expect(newPasswordSchema.safeParse(' '.repeat(20)).success).toBe(false);
    expect(newPasswordSchema.parse(`  ${PASSWORD}  `)).toBe(`  ${PASSWORD}  `);
  });
});

describe('registerRequestSchema', () => {
  it('accepte une inscription complète avec attribution', () => {
    const result = registerRequestSchema.safeParse({
      email: 'Rai@Example.com',
      password: PASSWORD,
      acceptTerms: true,
      attribution: {
        utmSource: 'x',
        utmMedium: 'social',
        utmCampaign: 'lancement',
        referrer: 'https://t.co/abc',
        landingPath: '/guides/rug-pull?ref=1',
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.email).toBe('rai@example.com');
  });

  it('exige l’acceptation des conditions', () => {
    expect(
      registerRequestSchema.safeParse({ email: 'rai@example.com', password: PASSWORD, acceptTerms: false })
        .success,
    ).toBe(false);
  });

  it('refuse un mot de passe trop court', () => {
    expect(
      registerRequestSchema.safeParse({ email: 'rai@example.com', password: 'court', acceptTerms: true })
        .success,
    ).toBe(false);
  });
});

describe('signupAttributionSchema', () => {
  it('ignore les clés inconnues et accepte un objet vide', () => {
    expect(signupAttributionSchema.parse({ autre: 'x' })).toEqual({});
  });

  it('refuse un referrer non http(s) et une page d’arrivée absolue', () => {
    expect(signupAttributionSchema.safeParse({ referrer: 'javascript:alert(1)' }).success).toBe(false);
    expect(signupAttributionSchema.safeParse({ landingPath: 'https://evil.example' }).success).toBe(false);
  });

  it('refuse les caractères de contrôle et les valeurs trop longues', () => {
    expect(signupAttributionSchema.safeParse({ utmSource: 'a\u0000b' }).success).toBe(false);
    expect(signupAttributionSchema.safeParse({ utmCampaign: 'a'.repeat(201) }).success).toBe(false);
  });
});

describe('relativePathSchema (pas de redirection ouverte)', () => {
  it.each(['/compte', '/t/abc?x=1'])('accepte %s', (path) => {
    expect(relativePathSchema.safeParse(path).success).toBe(true);
  });

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example', 'compte', '/a\nb'])(
    'refuse %j',
    (path) => {
      expect(relativePathSchema.safeParse(path).success).toBe(false);
    },
  );
});

describe('connexion, lien magique, vérification, réinitialisation', () => {
  it('connexion : mot de passe requis, sans règle de longueur minimale', () => {
    expect(loginRequestSchema.safeParse({ email: 'rai@example.com', password: 'x' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ email: 'rai@example.com', password: '' }).success).toBe(false);
  });

  it('lien magique : chemin de retour relatif uniquement', () => {
    expect(magicLinkRequestSchema.safeParse({ email: 'rai@example.com', redirectPath: '/suivis' }).success).toBe(true);
    expect(
      magicLinkRequestSchema.safeParse({ email: 'rai@example.com', redirectPath: '//evil.example' }).success,
    ).toBe(false);
  });

  it('jetons opaques base64url', () => {
    expect(magicLinkVerifyRequestSchema.safeParse({ token: TOKEN }).success).toBe(true);
    expect(verifyEmailRequestSchema.safeParse({ token: 'court' }).success).toBe(false);
    expect(verifyEmailRequestSchema.safeParse({ token: `${'a'.repeat(40)}<>` }).success).toBe(false);
  });

  it('renvoi de vérification : e-mail facultatif', () => {
    expect(resendVerificationRequestSchema.safeParse({}).success).toBe(true);
    expect(resendVerificationRequestSchema.safeParse({ email: 'x' }).success).toBe(false);
  });

  it('mot de passe oublié puis réinitialisation', () => {
    expect(forgotPasswordRequestSchema.safeParse({ email: 'rai@example.com' }).success).toBe(true);
    expect(resetPasswordRequestSchema.safeParse({ token: TOKEN, password: PASSWORD }).success).toBe(true);
    expect(resetPasswordRequestSchema.safeParse({ token: TOKEN, password: 'court' }).success).toBe(false);
  });

  it('changement : le nouveau mot de passe doit différer de l’actuel', () => {
    const result = changePasswordRequestSchema.safeParse({ currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['newPassword']);
  });
});

describe('profil et session', () => {
  it('valide un profil public avec essai actif', () => {
    expect(publicUserSchema.safeParse(user).success).toBe(true);
  });

  it('retire tout champ sensible non déclaré', () => {
    const parsed = publicUserSchema.parse({ ...user, passwordHash: 'x', stripeCustomerId: 'cus_1' });
    expect(parsed).not.toHaveProperty('passwordHash');
    expect(parsed).not.toHaveProperty('stripeCustomerId');
  });

  it('refuse un plan ou un rôle inconnu', () => {
    expect(publicUserSchema.safeParse({ ...user, plan: 'ENTERPRISE' }).success).toBe(false);
    expect(publicUserSchema.safeParse({ ...user, role: 'root' }).success).toBe(false);
  });

  it('accepte un essai jamais commencé (dates nulles)', () => {
    expect(
      publicUserSchema.safeParse({
        ...user,
        emailVerified: false,
        plan: 'FREE',
        trial: { status: 'none', startedAt: null, endsAt: null },
      }).success,
    ).toBe(true);
  });

  it('valide une réponse de session et le jeton CSRF', () => {
    const csrfToken = 'b'.repeat(43);
    expect(authSessionSchema.safeParse({ user, accessTokenExpiresAt: NOW, csrfToken }).success).toBe(true);
    expect(csrfResponseSchema.safeParse({ csrfToken: 'court' }).success).toBe(false);
    expect(CSRF_HEADER).toBe('X-CSRF-Token');
  });

  it('état de session : anonyme sans 401, ou session complète', () => {
    const csrfToken = 'b'.repeat(43);
    expect(sessionStateSchema.parse({ authenticated: false })).toEqual({ authenticated: false });
    expect(
      sessionStateSchema.safeParse({ authenticated: true, user, accessTokenExpiresAt: NOW, csrfToken }).success,
    ).toBe(true);
    expect(sessionStateSchema.safeParse({ authenticated: true }).success).toBe(false);
    expect(sessionStateSchema.safeParse({ user, accessTokenExpiresAt: NOW, csrfToken }).success).toBe(false);
  });

  it('réponse neutre non vide', () => {
    expect(messageResponseSchema.safeParse({ message: '' }).success).toBe(false);
  });
});

describe('codes d’erreur d’auth', () => {
  it('sont acceptés par le format d’erreur standard', () => {
    for (const code of AUTH_ERROR_CODES) {
      expect(apiErrorSchema.safeParse({ code, message: AUTH_ERROR_MESSAGES[code] }).success).toBe(true);
    }
  });

  it('ont tous un message français', () => {
    expect(Object.keys(AUTH_ERROR_MESSAGES).sort()).toEqual([...AUTH_ERROR_CODES].sort());
  });
});
