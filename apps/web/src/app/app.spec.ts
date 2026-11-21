import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { appRoutes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('crée la coquille avec un router-outlet', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('router-outlet')).not.toBeNull();
  });

  it('déclare les routes lazy des features et /_design en dev', () => {
    const paths = appRoutes.map((route) => route.path);
    expect(paths).toEqual(
      expect.arrayContaining(['analyse', 'suivis', 'wallet', 'compte', '_design']),
    );
    expect(appRoutes.find((r) => r.path === 'analyse')?.loadChildren).toBeDefined();
  });
});
