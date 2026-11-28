import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { type PublicUser } from '@raijin/shared-contracts';
import { AUTH_INTERCEPTORS, AuthStore, CsrfToken, fakeSession, loadContracts } from '@raijin/web-data-access';
import { webFeatureWalletRoutes } from '../lib.routes';

@Component({ template: '<h1>Autre écran</h1>' })
class Blank {}

export const API = '/api/v1';
export const SCANS = `${API}/wallet-scans`;
export const QUOTA = `${API}/wallet-scans/quota`;
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Monte `/wallet` avec les vrais store d'auth et intercepteurs, l'API étant simulée. */
export async function setupFeature(auth: 'authenticated' | 'anonymous' = 'authenticated', user: Partial<PublicUser> = {}) {
  await loadContracts();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'wallet', children: webFeatureWalletRoutes },
        { path: '**', component: Blank },
      ]),
      provideHttpClient(withInterceptors([...AUTH_INTERCEPTORS])),
      provideHttpClientTesting(),
    ],
  });
  const store = TestBed.inject(AuthStore);
  if (auth === 'authenticated') store.applySession(fakeSession({ plan: 'PRO', ...user }));
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

export function queryAll<T extends Element = HTMLElement>(harness: RouterTestingHarness, selector: string): T[] {
  return Array.from(root(harness).querySelectorAll<T>(selector));
}

export function button(harness: RouterTestingHarness, text: string): HTMLButtonElement | undefined {
  return queryAll<HTMLButtonElement>(harness, 'button').find((b) => b.textContent?.includes(text));
}

export function typeInput(harness: RouterTestingHarness, value: string): void {
  const input = query<HTMLInputElement>(harness, 'input[name="wallet"]');
  if (!input) throw new Error('champ absent');
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

export function submitForm(harness: RouterTestingHarness): void {
  const form = query<HTMLFormElement>(harness, 'form');
  if (!form) throw new Error('formulaire absent');
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

/** Attend une requête (écran chargé à la demande), puis la renvoie. */
export async function expectRequest(ctrl: HttpTestingController, url: string): Promise<TestRequest> {
  let request: TestRequest | undefined;
  await waitFor(() => (request ??= ctrl.match((r) => r.url === url)[0]) !== undefined, `requête ${url}`);
  return request as TestRequest;
}

/** Attend qu'une condition soit vraie (vérifie toutes les 10 ms, garde-fou de 10 s). */
export async function waitFor(condition: () => boolean, what = 'condition attendue'): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Délai dépassé : ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Rendu stabilisé après une réponse simulée. */
export async function stable(harness: RouterTestingHarness): Promise<void> {
  await settle();
  await harness.fixture.whenStable();
  await settle();
}
