import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { MAINTENANCE_PATH, maintenanceInterceptor } from './maintenance';

@Component({ template: '' })
class Blank {}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(start = '/suivis') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: Blank }]),
      provideHttpClient(withInterceptors([maintenanceInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  const router = TestBed.inject(Router);
  await router.navigateByUrl(start);
  return { router, http: TestBed.inject(HttpClient), ctrl: TestBed.inject(HttpTestingController) };
}

describe('maintenanceInterceptor', () => {
  it('503 MAINTENANCE : /maintenance avec retour vers l’écran demandé, erreur transmise', async () => {
    const { router, http, ctrl } = await setup('/suivis?x=1');
    const request = firstValueFrom(http.get('/api/v1/watches'));
    ctrl.expectOne('/api/v1/watches').flush({ code: 'MAINTENANCE', message: 'x' }, { status: 503, statusText: 'Service Unavailable' });
    await expect(request).rejects.toBeTruthy();
    await settle();
    expect(router.url).toBe(`${MAINTENANCE_PATH}?redirect=%2Fsuivis%3Fx%3D1`);
  });

  it('autre 503 ou hors API : pas de redirection', async () => {
    const { router, http, ctrl } = await setup('/suivis');
    const upstream = firstValueFrom(http.get('/api/v1/watches'));
    ctrl.expectOne('/api/v1/watches').flush({ code: 'UPSTREAM_UNAVAILABLE', message: 'x' }, { status: 503, statusText: 'x' });
    await expect(upstream).rejects.toBeTruthy();
    const external = firstValueFrom(http.get('https://exemple.fr/x'));
    ctrl.expectOne('https://exemple.fr/x').flush({ code: 'MAINTENANCE', message: 'x' }, { status: 503, statusText: 'x' });
    await expect(external).rejects.toBeTruthy();
    await settle();
    expect(router.url).toBe('/suivis');
  });
});
