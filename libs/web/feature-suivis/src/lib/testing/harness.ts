import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { type PublicUser } from '@raijin/shared-contracts';
import { AUTH_INTERCEPTORS, AuthStore, CsrfToken, fakeSession, loadContracts } from '@raijin/web-data-access';
import { webFeatureAlertesRoutes, webFeatureSuivisRoutes } from '../lib.routes';

@Component({ template: '<h1>Autre écran</h1>' })
class Blank {}

export const API = '/api/v1';
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Monte `/suivis` et `/alertes` avec les vrais stores et intercepteurs, l'API étant simulée. */
export async function setupFeature(auth: 'authenticated' | 'anonymous' = 'authenticated', user: Partial<PublicUser> = {}) {
  await loadContracts();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(
        [
          { path: 'suivis', children: webFeatureSuivisRoutes },
          { path: 'alertes', children: webFeatureAlertesRoutes },
          { path: '**', component: Blank },
        ],
        withComponentInputBinding(),
      ),
      provideHttpClient(withInterceptors([...AUTH_INTERCEPTORS])),
      provideHttpClientTesting(),
    ],
  });
  const store = TestBed.inject(AuthStore);
  if (auth === 'authenticated') store.applySession(fakeSession(user));
  else store.clear();
  store.whenReady = () => Promise.resolve();
  TestBed.inject(CsrfToken).set('csrf-session-token-0123456789abcdef');
  const harness = await RouterTestingHarness.create();
  return { harness, ctrl: TestBed.inject(HttpTestingController), router: TestBed.inject(Router) };
}

export function root(harness: RouterTestingHarness): HTMLElement {
  return harness.routeNativeElement as HTMLElement;
}

export function query<T extends Element = HTMLElement>(harness: RouterTestingHarness, selector: string): T | null {
  return root(harness).querySelector<T>(selector);
}

export function queryAll(harness: RouterTestingHarness, selector: string): HTMLElement[] {
  return Array.from(root(harness).querySelectorAll<HTMLElement>(selector));
}

export function button(harness: RouterTestingHarness, text: string): HTMLButtonElement | undefined {
  return queryAll(harness, 'button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
}

export function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

/** Attend une requête (écrans chargés à la demande), puis la renvoie. */
export async function expectRequest(ctrl: HttpTestingController, match: string | ((r: { url: string; method: string }) => boolean), attempts = 100): Promise<TestRequest> {
  const matcher = typeof match === 'string' ? (r: { url: string }) => r.url === match : match;
  for (let i = 0; i < attempts; i++) {
    const [request] = ctrl.match((r) => matcher(r));
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return ctrl.expectOne((r) => matcher(r));
}

export async function waitFor(condition: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Rendu stabilisé après une réponse simulée. */
export async function stable(harness: RouterTestingHarness): Promise<void> {
  await settle();
  await harness.fixture.whenStable();
  await settle();
}
