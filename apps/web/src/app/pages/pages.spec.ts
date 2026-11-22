import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { MaintenancePage } from './maintenance.page';
import { NotFoundPage } from './not-found.page';

@Component({ template: '<p>écran</p>' })
class Blank {}

async function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(
        [
          { path: 'maintenance', component: MaintenancePage },
          { path: 'suivis', component: Blank },
          { path: 'analyse', component: Blank },
          { path: '**', component: NotFoundPage },
        ],
        withComponentInputBinding(),
      ),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  return { harness: await RouterTestingHarness.create(), router: TestBed.inject(Router) };
}

describe('pages d’état', () => {
  it('404 : Rai bravo, titre, une seule action jaune (retour à l’analyse)', async () => {
    const { harness } = await setup();
    await harness.navigateByUrl('/nimporte/quoi');
    const host = harness.routeNativeElement as HTMLElement;
    expect(host.querySelector('h1')?.textContent).toContain('Cette page n’existe pas');
    expect(host.querySelector('img')?.getAttribute('src')).toContain('rai-bravo.svg');
    const primaries = host.querySelectorAll('.bg-thunder');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.getAttribute('href')).toBe('/analyse');
  });

  it('maintenance : « Réessayer » repart vers l’écran demandé (chemin interne seulement)', async () => {
    const { harness, router } = await setup();
    await harness.navigateByUrl('/maintenance?redirect=%2Fsuivis');
    const host = harness.routeNativeElement as HTMLElement;
    expect(host.textContent).toContain('courte pause');
    (host.querySelector('button') as HTMLButtonElement).click();
    await harness.fixture.whenStable();
    expect(router.url).toBe('/suivis');
    await harness.navigateByUrl('/maintenance?redirect=https%3A%2F%2Fevil.example');
    ((harness.routeNativeElement as HTMLElement).querySelector('button') as HTMLButtonElement).click();
    await harness.fixture.whenStable();
    expect(router.url).toBe('/analyse');
  });
});
