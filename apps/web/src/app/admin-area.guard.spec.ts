import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type ActivatedRouteSnapshot } from '@angular/router';
import { AUTH_ROUTES, AuthStore, fakeSession } from '@raijin/web-data-access';
import { ADMIN_LOGIN_PATH, adminAreaGuard } from './admin-area.guard';
import { hidesAppChrome } from './app';

@Component({ template: '<h1>Admin</h1>' })
class AdminStub {}

@Component({ template: '<h1>Page introuvable</h1>' })
class NotFoundStub {}

@Component({ template: '<h1>Connexion</h1>' })
class LoginStub {}

async function setup(state: 'admin' | 'user' | 'anonymous' | 'error') {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'admin', canMatch: [adminAreaGuard], data: { appChrome: false }, children: [{ path: '**', component: AdminStub }] },
        { path: 'compte/connexion', component: LoginStub },
        { path: '**', component: NotFoundStub },
      ]),
    ],
  });
  const auth = TestBed.inject(AuthStore);
  if (state === 'admin') auth.applySession(fakeSession({ role: 'ADMIN' }));
  else if (state === 'user') auth.applySession(fakeSession({ role: 'USER' }));
  else auth.clear();
  auth.whenReady = () => Promise.resolve();
  if (state === 'error') vi.spyOn(auth, 'status').mockReturnValue('error');
  const router = TestBed.inject(Router);
  await router.navigateByUrl('/admin/trafic');
  const leaf = (snapshot: ActivatedRouteSnapshot): ActivatedRouteSnapshot => (snapshot.firstChild ? leaf(snapshot.firstChild) : snapshot);
  return { router, component: leaf(router.routerState.snapshot.root).component };
}

describe('adminAreaGuard', () => {
  it('admin : la feature admin se charge', async () => {
    const { router, component } = await setup('admin');
    expect(component).toBe(AdminStub);
    expect(router.url).toBe('/admin/trafic');
  });

  it('compte sans rôle ADMIN : page 404 standard, même URL (espace invisible)', async () => {
    const { router, component } = await setup('user');
    expect(component).toBe(NotFoundStub);
    expect(router.url).toBe('/admin/trafic');
  });

  it('visiteur : connexion avec retour vers l’admin', async () => {
    const { router, component } = await setup('anonymous');
    expect(component).toBe(LoginStub);
    expect(router.url).toBe('/compte/connexion?redirect=%2Fadmin%2Ftrafic');
  });

  it('chemin de connexion aligné sur les gardes d’auth', () => {
    expect(ADMIN_LOGIN_PATH).toBe(AUTH_ROUTES.login);
  });

  it('API injoignable : 404 standard, le chunk admin n’est pas chargé', async () => {
    const { router, component } = await setup('error');
    expect(component).toBe(NotFoundStub);
    expect(router.url).toBe('/admin/trafic');
  });

  it('la route admin masque la coque de l’app', async () => {
    const { router } = await setup('admin');
    expect(hidesAppChrome(router.routerState.snapshot.root)).toBe(true);
    await router.navigateByUrl('/ailleurs');
    expect(hidesAppChrome(router.routerState.snapshot.root)).toBe(false);
  });
});
