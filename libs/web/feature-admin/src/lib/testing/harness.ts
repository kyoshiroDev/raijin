import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { AUTH_INTERCEPTORS, AuthStore, CsrfToken, adminSessionInterceptor, fakeSession, loadContracts } from '@raijin/web-data-access';
import { webFeatureAdminRoutes } from '../lib.routes';
import { RJ_CHART_LOADER, type RjChartFactory, type RjChartInstance } from '../ui/chart/chart-loader';

@Component({ template: '<h1>Autre écran</h1>' })
class Blank {}

export const API = '/api/v1';
export const STATUS = `${API}/admin/security/status`;
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Doublure de Chart.js : garde la dernière configuration reçue (aucun canvas en jsdom). */
export class FakeCharts {
  readonly created: { canvas: HTMLCanvasElement; instance: RjChartInstance }[] = [];
  updates = 0;
  destroyed = 0;
  readonly factory: RjChartFactory = (canvas, config) => {
    const instance: RjChartInstance = {
      config,
      data: config.data,
      options: config.options,
      update: () => void this.updates++,
      destroy: () => void this.destroyed++,
    };
    this.created.push({ canvas, instance });
    return instance;
  };
  get last(): RjChartInstance | undefined {
    return this.created[this.created.length - 1]?.instance;
  }
}

/** Monte `/admin` (feature réelle, intercepteurs réels, API simulée). */
export async function setupAdmin() {
  await loadContracts();
  const charts = new FakeCharts();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(
        [
          { path: 'admin', children: webFeatureAdminRoutes },
          { path: '**', component: Blank },
        ],
        withComponentInputBinding(),
      ),
      provideHttpClient(withInterceptors([adminSessionInterceptor, ...AUTH_INTERCEPTORS])),
      provideHttpClientTesting(),
      { provide: RJ_CHART_LOADER, useValue: () => Promise.resolve(charts.factory) },
    ],
  });
  const auth = TestBed.inject(AuthStore);
  auth.applySession(fakeSession({ role: 'ADMIN' }));
  TestBed.inject(CsrfToken).set('csrf-session-token-0123456789abcdef');
  const harness = await RouterTestingHarness.create();
  return { harness, ctrl: TestBed.inject(HttpTestingController), router: TestBed.inject(Router), charts };
}

/** Lance une navigation sans l'attendre (les gardes attendent des réponses HTTP simulées). */
export function navigate(router: Router, url: string): Promise<boolean> {
  return router.navigateByUrl(url);
}

/** Laisse passer microtâches, chargements de chunks et rendus. */
export async function flush(harness: RouterTestingHarness, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await settle();
    harness.detectChanges();
  }
  await harness.fixture.whenStable();
}

export function text(harness: RouterTestingHarness): string {
  return (harness.routeNativeElement?.textContent ?? '').replace(/\s+/g, ' ');
}
