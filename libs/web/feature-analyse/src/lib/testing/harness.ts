import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
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

export async function waitFor(condition: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
