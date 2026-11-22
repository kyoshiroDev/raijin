import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { isAnonymousState } from './auth/auth-api';
import { CsrfToken } from './auth/csrf-token';
import { AUTH_INTERCEPTORS } from './http/interceptors';
import { provideRaijinAuth } from './provide-auth';
import { provideStartupPrefetch } from './startup-prefetch';
import { CSRF_ANON } from './testing/fixtures';

@Component({ template: '<h1>Écran</h1>' })
class Blank {}

const API = '/api/v1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(pathname: string) {
  // URL d'arrivée de la page (jsdom) : lue par l'initialiseur au démarrage.
  window.history.replaceState({}, '', pathname);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: Blank }]),
      provideRaijinAuth(),
      provideStartupPrefetch({ csrf: [/^\/analyse\/[^/]+\/?$/] }),
      provideHttpClient(withInterceptors([...AUTH_INTERCEPTORS])),
      provideHttpClientTesting(),
    ],
  });
  await TestBed.inject(ApplicationInitStatus).donePromise;
  return TestBed.inject(HttpTestingController);
}

describe('provideRaijinAuth + provideStartupPrefetch', () => {
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('page d’arrivée avec mutation : jeton CSRF demandé dès le démarrage, session seulement après le rendu', async () => {
    const ctrl = await boot('/analyse/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    ctrl.expectOne(`${API}/auth/csrf`).flush({ csrfToken: CSRF_ANON });
    expect(TestBed.inject(CsrfToken).token()).toBe(CSRF_ANON);
    ctrl.expectNone(`${API}/auth/session`);
    const harness = await RouterTestingHarness.create('/analyse');
    harness.detectChanges();
    let [session] = ctrl.match(`${API}/auth/session`);
    for (let i = 0; i < 50 && !session; i++) {
      await sleep(10);
      [session] = ctrl.match(`${API}/auth/session`);
    }
    expect(session).toBeDefined();
    session?.flush({ authenticated: false });
  });

  it('autre page : aucun appel au démarrage', async () => {
    const ctrl = await boot('/analyse');
    ctrl.expectNone(`${API}/auth/csrf`);
    ctrl.expectNone(`${API}/auth/session`);
  });
});

describe('isAnonymousState', () => {
  it('reconnaît { authenticated: false } sans Zod, et seulement lui', () => {
    expect(isAnonymousState({ authenticated: false })).toBe(true);
    expect(isAnonymousState({ authenticated: false, extra: 1 })).toBe(true);
    for (const body of [null, undefined, 'false', {}, { authenticated: 'false' }, { authenticated: 0 }, { authenticated: true }]) {
      expect(isAnonymousState(body)).toBe(false);
    }
  });
});
