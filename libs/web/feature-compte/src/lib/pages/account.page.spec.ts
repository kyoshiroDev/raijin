import { API, query, queryAll, settle, setupFeature, type, waitFor } from '../testing/harness';
import { trialText } from './account.page';
import { fakeUser } from '@raijin/web-data-access';

// Premier chargement des écrans lazy : lent quand la machine compile en parallèle.
vi.setConfig({ testTimeout: 30_000 });

describe('AccountPage', () => {
  it('visiteur : renvoyé vers la connexion avec retour au compte', async () => {
    const { harness, router } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte');
    await waitFor(() => router.url.startsWith('/compte/connexion'));
    expect(router.url).toBe('/compte/connexion?redirect=%2Fcompte');
  });

  it('session en cours de récupération : skeleton (aria-busy), sans mascotte', async () => {
    const { harness, ctrl } = await setupFeature('loading');
    await harness.navigateByUrl('/compte');
    expect(query(harness, '[aria-busy="true"]')?.getAttribute('aria-label')).toBe('Chargement du compte');
    expect(queryAll(harness, 'rj-skeleton').length).toBeGreaterThan(0);
    expect(query(harness, 'rj-mascot')).toBeNull();
    ctrl.match(() => true).forEach((r) => r.flush(null, { status: 401, statusText: 'Unauthorized' }));
  });

  it('API injoignable : Rai alerte et Réessayer', async () => {
    const { harness, ctrl } = await setupFeature('error');
    await harness.navigateByUrl('/compte');
    expect(query(harness, '[role="alert"] img')?.getAttribute('src')).toContain('rai-alerte.svg');
    const retry = queryAll(harness, 'button').find((b) => b.textContent?.includes('Réessayer'));
    retry?.click();
    ctrl.expectOne(`${API}/auth/session`).flush({ code: 'INTERNAL_ERROR', message: 'x' }, { status: 500, statusText: 'Error' });
    await settle();
  });

  it('profil, statut avec icône + mot, plan, aucune action jaune', async () => {
    const { harness } = await setupFeature('authenticated', { emailVerified: false });
    await harness.navigateByUrl('/compte');
    const text = harness.routeNativeElement?.textContent ?? '';
    expect(query(harness, 'h1')?.textContent).toContain('Compte');
    expect(text).toContain('kenji@exemple.fr');
    expect(text).toContain('À confirmer');
    expect(text).toContain('Gratuit');
    expect(text).toContain('pas un conseil en investissement');
    expect(queryAll(harness, '.bg-thunder')).toHaveLength(0);
  });

  it('suppression : mot de passe exigé, puis DELETE /users/me { password }', async () => {
    const { harness, ctrl, router } = await setupFeature('authenticated');
    await harness.navigateByUrl('/compte');
    queryAll(harness, 'button').find((b) => b.textContent?.includes('Supprimer le compte'))?.click();
    await harness.fixture.whenStable();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Supprimer ton compte');
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.includes('Supprimer définitivement'));
    expect(confirm?.disabled).toBe(true);
    expect(dialog.querySelector('input[name="current-password"]')?.getAttribute('autocomplete')).toBe('current-password');
    type(harness, 'Ton mot de passe, pour confirmer', 'mon mot de passe');
    await harness.fixture.whenStable();
    expect(confirm?.disabled).toBe(false);
    confirm?.click();
    const req = ctrl.expectOne(`${API}/users/me`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toEqual({ password: 'mon mot de passe' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await waitFor(() => router.url === '/analyse');
    expect(router.url).toBe('/analyse');
  });

  it('changement de mot de passe : mauvais mot de passe actuel signalé sur le champ', async () => {
    const { harness, ctrl } = await setupFeature('authenticated');
    await harness.navigateByUrl('/compte');
    queryAll(harness, 'button').find((b) => b.textContent?.includes('Changer le mot de passe'))?.click();
    await harness.fixture.whenStable();
    type(harness, 'Mot de passe actuel', 'ancien');
    type(harness, 'Nouveau mot de passe', 'une nouvelle phrase longue');
    (document.querySelector('[role="dialog"] form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    ctrl
      .expectOne(`${API}/auth/password/change`)
      .flush({ code: 'AUTH_INVALID_CREDENTIALS', message: 'x' }, { status: 401, statusText: 'Unauthorized' });
    await settle();
    await harness.fixture.whenStable();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Mot de passe actuel incorrect.');
    ctrl.expectNone(`${API}/auth/refresh`);
  });

  it('déconnexion : retour à la connexion', async () => {
    const { harness, ctrl, router, store } = await setupFeature('authenticated');
    await harness.navigateByUrl('/compte');
    queryAll(harness, 'button').find((b) => b.textContent?.includes('Se déconnecter'))?.click();
    await settle();
    ctrl.expectOne(`${API}/auth/logout`).flush(null, { status: 204, statusText: 'No Content' });
    await waitFor(() => router.url === '/compte/connexion');
    expect(store.isAuthenticated()).toBe(false);
    expect(router.url).toBe('/compte/connexion');
  });

  it('?section=notifications (lien des e-mails d’alerte) : focus sur la carte Notifications', async () => {
    const { harness } = await setupFeature('authenticated');
    await harness.navigateByUrl('/compte?section=notifications');
    await waitFor(() => document.activeElement?.id === 'rj-notifications-title');
    expect(document.activeElement?.id).toBe('rj-notifications-title');
    // Le titre focalisé est bien celui de cet écran.
    expect(query(harness, '#notifications')?.contains(document.activeElement)).toBe(true);
  });

  it('texte d’essai factuel', () => {
    expect(trialText(fakeUser({ trial: { status: 'active', startedAt: null, endsAt: '2026-11-29T10:00:00.000Z' }, plan: 'PRO' }))).toBe(
      'Essai Pro en cours jusqu’au 29 novembre 2026.',
    );
    expect(trialText(fakeUser({ trial: { status: 'ended', startedAt: null, endsAt: null } }))).toBe('Ton essai Pro est terminé.');
    expect(trialText(fakeUser())).toBe('Tu utilises la formule gratuite de Raijin.');
  });
});
