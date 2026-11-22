import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { type PublicUser } from '@raijin/shared-contracts';
import { AUTH_INTERCEPTORS, AuthStore, CSRF_ANON, CsrfToken, fakeSession, loadContracts } from '@raijin/web-data-access';
import { webFeatureCompteRoutes } from '../lib.routes';

@Component({ template: '<h1>Autre écran</h1>' })
class Blank {}

export const API = '/api/v1';

/** Laisse passer promesses, navigation et rendu. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Monte les routes de la feature (`/compte/...`) avec le vrai store et les vrais intercepteurs,
 * l'API étant simulée par `HttpTestingController`.
 */
export async function setupFeature(auth: 'anonymous' | 'authenticated' | 'loading' | 'error', user: Partial<PublicUser> = {}) {
  // Contrats (chunk à la demande) chargés d'avance : les réponses se valident en microtâches.
  await loadContracts();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(
        [
          { path: 'compte', children: webFeatureCompteRoutes },
          { path: 'analyse', component: Blank },
          { path: 'suivis', component: Blank },
        ],
        withComponentInputBinding(),
      ),
      provideHttpClient(withInterceptors([...AUTH_INTERCEPTORS])),
      provideHttpClientTesting(),
    ],
  });
  const store = TestBed.inject(AuthStore);
  const ctrl = TestBed.inject(HttpTestingController);
  if (auth === 'authenticated') store.applySession(fakeSession(user));
  if (auth === 'anonymous') {
    store.clear();
    TestBed.inject(CsrfToken).set(CSRF_ANON);
  }
  // État de session déjà connu : les gardes ne redemandent pas la session.
  if (auth !== 'loading' && auth !== 'error') store.whenReady = () => Promise.resolve();
  if (auth === 'error') {
    const ready = store.init();
    ctrl.expectOne(`${API}/auth/session`).error(new ProgressEvent('error'));
    await ready;
  }
  const harness = await RouterTestingHarness.create();
  return { harness, store, ctrl, router: TestBed.inject(Router) };
}

export function query<T extends Element = HTMLElement>(harness: RouterTestingHarness, selector: string): T | null {
  return (harness.routeNativeElement as HTMLElement).querySelector<T>(selector);
}

export function queryAll(harness: RouterTestingHarness, selector: string): HTMLElement[] {
  return Array.from((harness.routeNativeElement as HTMLElement).querySelectorAll<HTMLElement>(selector));
}

/** Saisit une valeur dans le champ dont le libellé est `label`. */
export function type(harness: RouterTestingHarness, label: string, value: string): void {
  const labelEl = queryAll(harness, 'label').find((l) => l.textContent?.trim() === label) as HTMLLabelElement | undefined;
  const input = labelEl ? (harness.routeNativeElement as HTMLElement).querySelector<HTMLInputElement>(`#${labelEl.htmlFor}`) : null;
  if (!input) throw new Error(`Champ « ${label} » introuvable`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

export function submitForm(harness: RouterTestingHarness): void {
  const form = query<HTMLFormElement>(harness, 'form');
  if (!form) throw new Error('Formulaire introuvable');
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

/**
 * Attend qu'une condition soit vraie (écran chargé à la demande, tâche lancée à l'inactivité).
 * Vérifie toutes les 10 ms jusqu'à la réussite : la limite de 10 s n'est qu'un garde-fou, pas un
 * délai (un budget en nombre d'essais échouait sur une machine lente). Échoue explicitement.
 */
export async function waitFor(condition: () => boolean, what = 'condition attendue'): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Délai dépassé : ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
