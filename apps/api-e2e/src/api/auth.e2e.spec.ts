import { AUTH_EMAIL_LINK_PATHS, authSessionSchema, publicUserSchema, sessionStateSchema } from '@raijin/shared-contracts';
import { ApiClient, tokenFrom, uniqueEmail, waitForMail, waitForMailCount } from '../support/client';

/**
 * Parcours d'auth complets contre l'API réelle, Postgres et Mailpit de docker-compose.dev.yml.
 * Lancement : pnpm nx run api:dev-infra && pnpm nx run api-prisma:migrate-deploy && pnpm nx e2e api-e2e
 */
const PASSWORD = 'une phrase de passe e2e solide';

async function registerAndVerify(email: string, password = PASSWORD): Promise<ApiClient> {
  const client = await new ApiClient().init();
  const register = await client.post('/auth/register', { email, password, acceptTerms: true, attribution: { utmSource: 'e2e' } });
  expect(register.status).toBe(202);
  const text = await waitForMail(email, 'Confirme ton adresse');
  const verify = await client.post('/auth/verify-email', { token: tokenFrom(text, AUTH_EMAIL_LINK_PATHS.verifyEmail) });
  expect(verify.status).toBe(200);
  return client;
}

describe('API Raijin : santé', () => {
  it('GET /health : base joignable', async () => {
    const client = new ApiClient();
    const res = await client.get('/health');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ status: 'ok', service: 'raijin-api', database: 'up' });
  });

  it('GET /health/config retiré (phase 6 bis, M3) : 404, l’état des services est dans GET admin/health', async () => {
    const res = await new ApiClient().get('/health/config');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.data)).not.toMatch(/configured/);
  });
});

describe('API Raijin : parcours d’auth', () => {
  it('inscription → e-mail → vérification → /me → refresh → déconnexion', async () => {
    const email = uniqueEmail('parcours');
    const client = await new ApiClient().init();
    const register = await client.post('/auth/register', { email, password: PASSWORD, acceptTerms: true });
    expect(register.status).toBe(202);

    const text = await waitForMail(email, 'Confirme ton adresse');
    const token = tokenFrom(text, AUTH_EMAIL_LINK_PATHS.verifyEmail);
    const verify = await client.post('/auth/verify-email', { token });
    expect(verify.status).toBe(200);
    expect(authSessionSchema.parse(verify.data).user.emailVerified).toBe(true);
    expect(JSON.stringify(verify.data)).not.toMatch(/refresh|accessToken"/);
    await waitForMail(email, 'Bienvenue');

    const reuse = await client.post('/auth/verify-email', { token });
    expect(reuse.status).toBe(400);
    expect(reuse.data['code']).toBe('AUTH_TOKEN_INVALID');

    const me = await client.get('/users/me');
    expect(me.status).toBe(200);
    expect(publicUserSchema.parse(me.data).email).toBe(email);

    const before = client.clone();
    const refresh = await client.post('/auth/refresh');
    expect(refresh.status).toBe(200);
    expect(client.cookies.get('rj_rt')).not.toBe(before.cookies.get('rj_rt'));
    expect((await client.get('/users/me')).status).toBe(200);

    // L'ancien refresh, déjà utilisé, rejoué dans la fenêtre de grâce (onglet concurrent) :
    // 409 CONFLICT, sans révoquer la session ni effacer les cookies.
    const stale = await before.post('/auth/refresh');
    expect(stale.status).toBe(409);
    expect(stale.data['code']).toBe('CONFLICT');
    expect((await client.get('/users/me')).status).toBe(200);

    expect((await client.post('/auth/logout')).status).toBe(204);
    // Cookies effacés par la déconnexion : « pas connecté », le front ne tente pas de refresh.
    const after = await client.get('/users/me');
    expect(after.status).toBe(401);
    expect(after.data['code']).toBe('UNAUTHORIZED');
  });

  it('visiteur jamais connecté : session 200 anonyme (sans 401), csrf 200, refresh 401 UNAUTHORIZED', async () => {
    const visitor = new ApiClient();
    const session = await visitor.get('/auth/session');
    expect(session.status).toBe(200);
    expect(sessionStateSchema.parse(session.data)).toEqual({ authenticated: false });
    expect((await visitor.get('/auth/csrf')).status).toBe(200);
    const refresh = await visitor.post('/auth/refresh');
    expect(refresh.status).toBe(401);
    expect(refresh.data['code']).toBe('UNAUTHORIZED');
  });

  it('refresh après auth/csrf (front : auth/csrf puis auth/refresh), avec ou sans access token', async () => {
    const email = uniqueEmail('refresh-csrf');
    const client = await registerAndVerify(email);
    // auth/csrf après connexion : jeton lié à la session (seul accepté tant qu'un sid est lu).
    expect((await client.get('/auth/csrf')).status).toBe(200);
    expect((await client.post('/auth/refresh')).status).toBe(200);

    // Cookie d'access perdu (expiré côté navigateur) : csrf anonyme puis refresh, la session reprend.
    client.cookies.delete('rj_at');
    expect((await client.get('/auth/csrf')).status).toBe(200);
    const refreshed = await client.post('/auth/refresh');
    expect(refreshed.status).toBe(200);
    expect((await client.get('/users/me')).status).toBe(200);

    // Jeton CSRF lié à la session, conservé avec le cookie d'access (même si son JWT a expiré) : accepté.
    expect((await client.post('/auth/refresh')).status).toBe(200);
  });

  it('refresh d’une autre session ou nom de refresh répété (cookie injecté) : 401, sans consommer le refresh d’autrui', async () => {
    const victim = await registerAndVerify(uniqueEmail('fixation-victime'));
    const attacker = await registerAndVerify(uniqueEmail('fixation-attaquant'));
    const attackerRefresh = attacker.cookies.get('rj_rt') ?? '';
    expect(attackerRefresh).not.toBe('');

    // Refresh de l'attaquant glissé à côté de l'access de la victime : sid différent, refusé.
    const forged = victim.clone();
    forged.cookies.set('rj_rt', attackerRefresh);
    const mismatch = await forged.post('/auth/refresh');
    expect(mismatch.status).toBe(401);
    expect(mismatch.data['code']).toBe('AUTH_SESSION_EXPIRED');
    // Le refresh de l'attaquant n'a été ni consommé ni révoqué.
    expect((await attacker.post('/auth/refresh')).status).toBe(200);

    // Deux cookies de refresh du même nom dans l'en-tête : refusé avant toute rotation.
    const doubled = victim.clone();
    doubled.cookies.set('rj_rt', `${attacker.cookies.get('rj_rt') ?? ''}; rj_rt=${victim.cookies.get('rj_rt') ?? ''}`);
    const duplicate = await doubled.post('/auth/refresh');
    expect(duplicate.status).toBe(401);
    expect(duplicate.data['code']).toBe('AUTH_SESSION_EXPIRED');
    // La session de la victime reste utilisable avec son propre refresh.
    expect((await victim.post('/auth/refresh')).status).toBe(200);
  });

  it('verify-email/resend connecté avec un corps vide : renvoi à l’adresse de la session', async () => {
    const email = uniqueEmail('resend');
    const client = await new ApiClient().init();
    expect((await client.post('/auth/register', { email, password: PASSWORD, acceptTerms: true })).status).toBe(202);
    await waitForMail(email, 'Confirme ton adresse');
    expect((await client.post('/auth/login', { email, password: PASSWORD })).status).toBe(200);
    const resend = await client.request('POST', '/auth/verify-email/resend');
    expect(resend.status).toBe(202);
    await waitForMailCount(email, 'Confirme ton adresse', 2);
  });

  it('connexion : identifiants faux neutres, succès, CSRF exigé', async () => {
    const email = uniqueEmail('connexion');
    await registerAndVerify(email);
    const client = await new ApiClient().init();
    const wrong = await client.post('/auth/login', { email, password: 'pas le bon mot de passe' });
    expect(wrong.status).toBe(401);
    expect(wrong.data['code']).toBe('AUTH_INVALID_CREDENTIALS');
    const unknown = await client.post('/auth/login', { email: uniqueEmail('inconnu'), password: 'pas le bon mot de passe' });
    expect(unknown.data).toEqual(wrong.data);

    const noCsrf = new ApiClient();
    expect((await noCsrf.post('/auth/login', { email, password: PASSWORD })).status).toBe(403);

    const ok = await client.post('/auth/login', { email: email.toUpperCase(), password: PASSWORD });
    expect(ok.status).toBe(200);
    expect((await client.get('/auth/session')).status).toBe(200);
  });

  it('verrouillage : réponse identique pour un compte verrouillé (même bon mot de passe) et une adresse inconnue', async () => {
    const email = uniqueEmail('verrou');
    await registerAndVerify(email);
    const ghost = uniqueEmail('fantome');
    const client = await new ApiClient().init();
    const responses: { status: number; data: unknown }[] = [];
    for (let i = 0; i < 5; i++) {
      const known = await client.post('/auth/login', { email, password: 'pas le bon mot de passe' });
      const unknown = await client.post('/auth/login', { email: ghost, password: 'pas le bon mot de passe' });
      responses.push(known, unknown);
    }
    const lockedKnown = await client.post('/auth/login', { email, password: PASSWORD });
    const lockedUnknown = await client.post('/auth/login', { email: ghost, password: PASSWORD });
    responses.push(lockedKnown, lockedUnknown);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.data).toEqual(responses[0]?.data);
    }
    expect((responses[0]?.data as { code: string }).code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('inscription d’une adresse existante : même réponse, e-mail « compte existant »', async () => {
    const email = uniqueEmail('existant');
    await registerAndVerify(email);
    const client = await new ApiClient().init();
    const again = await client.post('/auth/register', { email, password: 'une autre phrase de passe', acceptTerms: true });
    expect(again.status).toBe(202);
    await waitForMail(email, 'déjà un compte');
  });

  it('mot de passe oublié → réinitialisation : sessions révoquées, nouveau mot de passe actif', async () => {
    const email = uniqueEmail('reset');
    const session = await registerAndVerify(email);
    const client = await new ApiClient().init();
    expect((await client.post('/auth/password/forgot', { email })).status).toBe(202);
    const text = await waitForMail(email, 'Réinitialise');
    const reset = await client.post('/auth/password/reset', {
      token: tokenFrom(text, AUTH_EMAIL_LINK_PATHS.resetPassword),
      password: 'nouvelle phrase de passe e2e',
    });
    expect(reset.status).toBe(204);
    await waitForMail(email, 'mot de passe a changé');
    expect((await session.get('/users/me')).status).toBe(401);
    expect((await client.post('/auth/login', { email, password: PASSWORD })).status).toBe(401);
    expect((await client.post('/auth/login', { email, password: 'nouvelle phrase de passe e2e' })).status).toBe(200);
  });

  it('lien magique : connexion et page de retour', async () => {
    const email = uniqueEmail('magique');
    await registerAndVerify(email);
    const client = await new ApiClient().init();
    expect((await client.post('/auth/magic-link', { email, redirectPath: '/suivis' })).status).toBe(202);
    const text = await waitForMail(email, 'lien de connexion');
    const verify = await client.post('/auth/magic-link/verify', { token: tokenFrom(text, AUTH_EMAIL_LINK_PATHS.magicLink) });
    expect(verify.status).toBe(200);
    expect(verify.data['redirectPath']).toBe('/suivis');
    expect((await client.get('/users/me')).status).toBe(200);
  });

  it('changement de mot de passe, export et suppression du compte (RGPD)', async () => {
    const email = uniqueEmail('rgpd');
    const client = await registerAndVerify(email);
    const other = await new ApiClient().init();
    expect((await other.post('/auth/login', { email, password: PASSWORD })).status).toBe(200);

    const change = await client.post('/auth/password/change', { currentPassword: PASSWORD, newPassword: 'phrase changée e2e ok' });
    expect(change.status).toBe(204);
    expect((await client.get('/users/me')).status).toBe(200);
    expect((await other.get('/users/me')).status).toBe(401);

    const exported = await client.get<{ account: { email: string; passwordHash?: string } }>('/users/me/export');
    expect(exported.status).toBe(200);
    expect(exported.data.account.email).toBe(email);
    expect(exported.data.account.passwordHash).toBeUndefined();

    expect((await client.delete('/users/me', { password: 'mauvais' })).status).toBe(400);
    expect((await client.delete('/users/me', { password: 'phrase changée e2e ok' })).status).toBe(204);
    expect((await client.get('/users/me')).status).toBe(401);
    const fresh = await new ApiClient().init();
    expect((await fresh.post('/auth/login', { email, password: 'phrase changée e2e ok' })).status).toBe(401);
  });
});
