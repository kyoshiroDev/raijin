import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { fakeSession } from '../testing/fixtures';
import { AuthStore, type AuthStatus } from './auth.store';
import { authGuard, guestGuard, verifiedEmailGuard } from './guards';

@Component({ template: '' })
class Blank {}

function setup(status: AuthStatus, emailVerified = true) {
  const store = {
    whenReady: vi.fn(() => Promise.resolve()),
    status: () => status,
    isAuthenticated: () => status === 'authenticated',
    emailVerified: () => emailVerified,
    applySession: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthStore, useValue: store },
      provideRouter([
        { path: 'compte', component: Blank, canActivate: [authGuard] },
        { path: 'compte/connexion', component: Blank, canActivate: [guestGuard] },
        { path: 'compte/verifier-email', component: Blank },
        { path: 'export', component: Blank, canActivate: [verifiedEmailGuard] },
        { path: 'analyse', component: Blank },
      ]),
    ],
  });
  return { router: TestBed.inject(Router), store };
}

describe('gardes de route', () => {
  it('authGuard : visiteur renvoyé vers la connexion avec retour', async () => {
    const { router, store } = setup('anonymous');
    await router.navigateByUrl('/compte');
    expect(store.whenReady).toHaveBeenCalled();
    expect(router.url).toBe('/compte/connexion?redirect=%2Fcompte');
  });

  it('authGuard : connecté, ou API injoignable (l’écran propose de réessayer)', async () => {
    const { router } = setup('authenticated');
    await router.navigateByUrl('/compte');
    expect(router.url).toBe('/compte');
    TestBed.resetTestingModule();
    const offline = setup('error');
    await offline.router.navigateByUrl('/compte');
    expect(offline.router.url).toBe('/compte');
  });

  it('guestGuard : un connecté repart vers redirect validé, jamais vers une autre origine', async () => {
    const { router } = setup('authenticated');
    await router.navigateByUrl('/compte/connexion?redirect=%2Fanalyse');
    expect(router.url).toBe('/analyse');
    await router.navigateByUrl('/compte/connexion?redirect=%2F%2Fevil.example');
    expect(router.url).toBe('/compte');
  });

  it('guestGuard : un visiteur voit l’écran', async () => {
    const { router } = setup('anonymous');
    await router.navigateByUrl('/compte/connexion');
    expect(router.url).toBe('/compte/connexion');
  });

  it('verifiedEmailGuard : e-mail non vérifié → « Vérifie ta boîte », visiteur → connexion', async () => {
    const { router } = setup('authenticated', false);
    await router.navigateByUrl('/export');
    expect(router.url).toBe('/compte/verifier-email');
    TestBed.resetTestingModule();
    const anon = setup('anonymous');
    await anon.router.navigateByUrl('/export');
    expect(anon.router.url).toBe('/compte/connexion?redirect=%2Fexport');
    TestBed.resetTestingModule();
    const ok = setup('authenticated', true);
    await ok.router.navigateByUrl('/export');
    expect(ok.router.url).toBe('/export');
    expect(fakeSession().user.emailVerified).toBe(true);
  });

  it('verifiedEmailGuard : API injoignable (hors ligne) → l’écran s’affiche avec son erreur, pas la connexion', async () => {
    const { router } = setup('error');
    await router.navigateByUrl('/export');
    expect(router.url).toBe('/export');
  });
});
