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

  it('affiche la barre d’onglets avec les 4 entrées et le bouton Notifications', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const tabs = Array.from(host.querySelectorAll('rj-tab-bar a')).map((a) => a.textContent?.trim());
    expect(tabs).toEqual(['Analyser', 'Suivis', 'Alertes', 'Compte']);
    expect(host.querySelector('button[aria-label="Notifications"]')).not.toBeNull();
    expect(host.querySelector('main#rj-main')).not.toBeNull();
  });

  it('déclare les routes des features et /_design en dev', () => {
    const paths = appRoutes.map((route) => route.path);
    expect(paths).toEqual(
      expect.arrayContaining(['analyse', 't', 'suivis', 'alertes', 'wallet', 'compte', '_design']),
    );
  });

  it('charge l’analyse et la page publique avec le bundle initial, les autres features à la demande', () => {
    // docs/ARCHITECTURE.md §10 : pas de cascade de chunks avant l'élément LCP de l'écran d'arrivée.
    for (const path of ['analyse', 't']) {
      const route = appRoutes.find((r) => r.path === path);
      expect(route?.children?.length).toBeGreaterThan(0);
      expect(route?.loadChildren).toBeUndefined();
    }
    for (const path of ['suivis', 'alertes', 'wallet', 'compte']) {
      expect(appRoutes.find((r) => r.path === path)?.loadChildren).toBeDefined();
    }
  });
});
