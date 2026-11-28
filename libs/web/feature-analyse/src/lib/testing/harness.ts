import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { loadContracts } from '@raijin/web-data-access';
import { webFeatureAnalyseRoutes, webFeaturePublicTokenRoutes } from '../lib.routes';

@Component({ template: '<h1>Autre écran</h1>' })
class Blank {}

export const API = '/api/v1';

/** Laisse passer promesses, navigation et rendu. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Monte `/analyse/...` et `/t/...` avec le vrai store, l'API étant simulée. */
export async function setupFeature() {
  await loadContracts();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(
        [
          { path: 'analyse', children: webFeatureAnalyseRoutes },
          { path: 't', children: webFeaturePublicTokenRoutes },
          { path: 'compte/inscription', component: Blank },
        ],
        withComponentInputBinding(),
      ),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
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

/** Saisit une valeur dans le champ de l'écran d'analyse. */
export function typeInput(harness: RouterTestingHarness, value: string): void {
  const input = query<HTMLInputElement>(harness, 'input[name="token"]');
  if (!input) throw new Error('Champ introuvable');
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

export function submitForm(harness: RouterTestingHarness): void {
  const form = query<HTMLFormElement>(harness, 'form');
  if (!form) throw new Error('Formulaire introuvable');
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

/** Attend qu'une requête parte (tâches lancées à l'inactivité du navigateur), puis la renvoie. */
export async function expectRequest(ctrl: HttpTestingController, url: string): Promise<TestRequest> {
  let request: TestRequest | undefined;
  await waitFor(() => (request ??= ctrl.match(url)[0]) !== undefined, `requête ${url}`);
  return request as TestRequest;
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
