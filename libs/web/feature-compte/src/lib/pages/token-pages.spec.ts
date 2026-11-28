import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { fakeSession } from '@raijin/web-data-access';
import { API, query, queryAll, settle, setupFeature, submitForm, type, waitFor } from '../testing/harness';

// Premier chargement des écrans lazy : lent quand la machine compile en parallèle.
vi.setConfig({ testTimeout: 30_000 });

const TOKEN = 'tok_' + 'a'.repeat(40);

describe('Lien magique (atterrissage)', () => {
  it('ouvre la session, retire le jeton de l’URL et suit un redirect interne', async () => {
    const { harness, ctrl, router, store } = await setupFeature('anonymous');
    await harness.navigateByUrl(`/compte/lien-magique?token=${TOKEN}&redirect=%2Fsuivis`);
    const req = ctrl.expectOne(`${API}/auth/magic-link/verify`);
    expect(req.request.body).toEqual({ token: TOKEN });
    await settle();
    expect(TestBed.inject(Location).path()).toBe('/compte/lien-magique?redirect=%2Fsuivis');
    req.flush({ ...fakeSession(), redirectPath: null });
    await settle();
    await settle();
    expect(store.isAuthenticated()).toBe(true);
    expect(router.url).toBe('/suivis');
  });

  it('redirect externe ignoré', async () => {
    const { harness, ctrl, router } = await setupFeature('anonymous');
    await harness.navigateByUrl(`/compte/lien-magique?token=${TOKEN}&redirect=%2F%2Fevil.example%2Fx`);
    ctrl.expectOne(`${API}/auth/magic-link/verify`).flush({ ...fakeSession(), redirectPath: null });
    await waitFor(() => router.url === '/compte');
    expect(router.url).toBe('/compte');
  });

  it('jeton refusé : Rai alerte et nouveau lien proposé', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl(`/compte/lien-magique?token=${TOKEN}`);
    ctrl
      .expectOne(`${API}/auth/magic-link/verify`)
      .flush({ code: 'AUTH_TOKEN_INVALID', message: 'x' }, { status: 400, statusText: 'Bad Request' });
    await settle();
    await harness.fixture.whenStable();
    expect(query(harness, '[role="alert"] img')?.getAttribute('src')).toContain('rai-alerte.svg');
    expect(harness.routeNativeElement?.textContent).toContain('Recevoir un nouveau lien');
    expect(queryAll(harness, 'rj-mascot')).toHaveLength(1);
  });

  it('jeton malformé : aucun appel API', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/lien-magique?token=%3Cscript%3E');
    await harness.fixture.whenStable();
    ctrl.expectNone(`${API}/auth/magic-link/verify`);
    expect(query(harness, 'h1')?.textContent).toContain('Connexion impossible');
  });
});

describe('Lien magique : redirectPath de l’API', () => {
  it('suit le redirectPath mémorisé par l’API, revalidé', async () => {
    const { harness, ctrl, router } = await setupFeature('anonymous');
    await harness.navigateByUrl(`/compte/lien-magique?token=${TOKEN}`);
    ctrl.expectOne(`${API}/auth/magic-link/verify`).flush({ ...fakeSession(), redirectPath: '/suivis' });
    await waitFor(() => router.url === '/suivis');
    expect(router.url).toBe('/suivis');
  });

  it('sans jeton, même chemin : page de demande', async () => {
    const { harness } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/lien-magique');
    expect(query(harness, 'h1')?.textContent).toContain('Connexion sans mot de passe');
  });
});

describe('Demande de lien magique', () => {
  it('transmet un redirectPath validé', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/lien-magique?redirect=%2Fsuivis');
    type(harness, 'Adresse e-mail', 'kenji@exemple.fr');
    submitForm(harness);
    const req = ctrl.expectOne(`${API}/auth/magic-link`);
    expect(req.request.body).toEqual({ email: 'kenji@exemple.fr', redirectPath: '/suivis' });
    req.flush({ message: 'ok' });
    await settle();
    await harness.fixture.whenStable();
    expect(query(harness, 'h1')?.textContent).toContain('Vérifie ta boîte mail');
  });
});

describe('Vérification d’e-mail', () => {
  it('lien valide : Rai bravo et une seule action jaune', async () => {
    const { harness, ctrl, store } = await setupFeature('anonymous');
    await harness.navigateByUrl(`/compte/verifier-email?token=${TOKEN}`);
    ctrl.expectOne(`${API}/auth/verify-email`).flush(fakeSession({ emailVerified: true }));
    await settle();
    await harness.fixture.whenStable();
    expect(store.emailVerified()).toBe(true);
    expect(query(harness, 'img')?.getAttribute('src')).toContain('rai-bravo.svg');
    expect(queryAll(harness, '.bg-thunder')).toHaveLength(1);
  });

  it('sans jeton, visiteur : renvoi avec l’e-mail saisi', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/verifier-email');
    type(harness, 'Adresse e-mail', 'kenji@exemple.fr');
    submitForm(harness);
    const req = ctrl.expectOne(`${API}/auth/verify-email/resend`);
    expect(req.request.body).toEqual({ email: 'kenji@exemple.fr' });
    req.flush({ message: 'ok' }, { status: 202, statusText: 'Accepted' });
  });
});

describe('Réinitialisation du mot de passe', () => {
  it('sans jeton : Rai alerte, aucun formulaire', async () => {
    const { harness } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/reinitialiser-mot-de-passe');
    expect(query(harness, 'form')).toBeNull();
    expect(query(harness, 'h1')?.textContent).toContain('Lien expiré');
  });

  it('jeton gardé en mémoire, retiré de l’URL ; succès : Rai bravo', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl(`/compte/reinitialiser-mot-de-passe?token=${TOKEN}`);
    await settle();
    expect(TestBed.inject(Location).path()).toBe('/compte/reinitialiser-mot-de-passe');
    type(harness, 'Nouveau mot de passe', 'une nouvelle phrase longue');
    submitForm(harness);
    const req = ctrl.expectOne(`${API}/auth/password/reset`);
    expect(req.request.body).toEqual({ token: TOKEN, password: 'une nouvelle phrase longue' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    await harness.fixture.whenStable();
    expect(query(harness, 'h1')?.textContent).toContain('Mot de passe modifié');
  });

  it('jeton expiré côté API : bascule sur Rai alerte', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl(`/compte/reinitialiser-mot-de-passe?token=${TOKEN}`);
    type(harness, 'Nouveau mot de passe', 'une nouvelle phrase longue');
    submitForm(harness);
    ctrl
      .expectOne(`${API}/auth/password/reset`)
      .flush({ code: 'AUTH_TOKEN_INVALID', message: 'x' }, { status: 400, statusText: 'Bad Request' });
    await settle();
    await harness.fixture.whenStable();
    expect(query(harness, '[role="alert"] img')?.getAttribute('src')).toContain('rai-alerte.svg');
  });
});

describe('Mot de passe oublié', () => {
  it('réponse neutre', async () => {
    const { harness, ctrl } = await setupFeature('anonymous');
    await harness.navigateByUrl('/compte/mot-de-passe-oublie');
    type(harness, 'Adresse e-mail', 'kenji@exemple.fr');
    submitForm(harness);
    ctrl.expectOne(`${API}/auth/password/forgot`).flush({ message: 'ok' }, { status: 202, statusText: 'Accepted' });
    await settle();
    await harness.fixture.whenStable();
    expect(harness.routeNativeElement?.textContent).toContain('Si cette adresse peut être utilisée');
  });
});
