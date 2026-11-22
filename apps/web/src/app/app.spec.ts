import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthStore, TRIAL_BANNER_STORAGE_KEY, UnreadAlerts, fakeSession } from '@raijin/web-data-access';
import { App, NAV_ITEMS, navItemsWithUnread } from './app';
import { appRoutes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
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
      expect.arrayContaining(['analyse', 't', 'suivis', 'alertes', 'wallet', 'compte', 'abonnement', 'maintenance', '_design', '**']),
    );
  });

  it('404 (route **) et maintenance : pages chargées à la demande, plus de redirection silencieuse', () => {
    const notFound = appRoutes.at(-1);
    expect(notFound?.path).toBe('**');
    expect(notFound?.redirectTo).toBeUndefined();
    expect(notFound?.loadComponent).toBeDefined();
    expect(appRoutes.find((r) => r.path === 'maintenance')?.loadComponent).toBeDefined();
  });

  it('badge des alertes non lues : onglet Alertes, barre latérale et cloche du header', async () => {
    expect(navItemsWithUnread(0)).toBe(NAV_ITEMS);
    expect(navItemsWithUnread(4).find((item) => item.path === '/alertes')?.badge).toBe(4);
    const fixture = TestBed.createComponent(App);
    TestBed.inject(UnreadAlerts).set(3);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('button[aria-label="Notifications, 3 non lues"]')).not.toBeNull();
    expect(host.querySelector('rj-tab-bar a[href="/alertes"]')?.textContent).toContain('3');
  });

  it('charge l’analyse et la page publique avec le bundle initial, les autres features à la demande', () => {
    // docs/ARCHITECTURE.md §10 : pas de cascade de chunks avant l'élément LCP de l'écran d'arrivée.
    for (const path of ['analyse', 't']) {
      const route = appRoutes.find((r) => r.path === path);
      expect(route?.children?.length).toBeGreaterThan(0);
      expect(route?.loadChildren).toBeUndefined();
    }
    for (const path of ['suivis', 'alertes', 'wallet', 'compte', 'abonnement']) {
      expect(appRoutes.find((r) => r.path === path)?.loadChildren).toBeDefined();
    }
  });

  it('bandeau d’essai : visible pendant l’essai, refermé jusqu’au lendemain, absent hors essai', async () => {
    localStorage.removeItem(TRIAL_BANNER_STORAGE_KEY);
    const endsAt = new Date(Date.now() + 3 * 86_400_000 - 60_000).toISOString();
    TestBed.inject(AuthStore).applySession(fakeSession({ plan: 'PRO', trial: { status: 'active', startedAt: new Date().toISOString(), endsAt } }));
    const fixture = TestBed.createComponent(App);
    const host = fixture.nativeElement as HTMLElement;
    // Bloc @defer : le chunk du bandeau se charge quand la session indique un essai.
    for (let i = 0; i < 50 && !host.querySelector('rj-trial-banner'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fixture.whenStable();
    }
    expect(host.querySelector('rj-trial-banner')?.textContent).toContain('Essai Pro : plus que 3 jours');
    host.querySelector<HTMLButtonElement>('rj-trial-banner button')?.click();
    await fixture.whenStable();
    expect(host.querySelector('rj-trial-banner')).toBeNull();
    expect(localStorage.getItem(TRIAL_BANNER_STORAGE_KEY)).not.toBeNull();
    localStorage.removeItem(TRIAL_BANNER_STORAGE_KEY);
  });

  it('pas de bandeau pour un compte sans essai actif', async () => {
    TestBed.inject(AuthStore).applySession(fakeSession());
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('rj-trial-banner-host')).toBeNull();
  });
});
