import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RjAppShell } from './app-shell';
import { type RjNavItem } from './nav-item';
import { RjSidebar } from './sidebar';
import { RjTabBar } from './tab-bar';

const ITEMS: RjNavItem[] = [
  { label: 'Analyser', path: '/analyse', icon: 'analyse' },
  { label: 'Suivis', path: '/suivis', icon: 'suivis' },
  { label: 'Alertes', path: '/alertes', icon: 'alertes', badge: 12 },
  { label: 'Compte', path: '/compte', icon: 'compte' },
  { label: 'Wallet', path: '/wallet', icon: 'wallet' },
];

@Component({
  imports: [RjSidebar],
  template: `<rj-sidebar [items]="items" [(collapsed)]="collapsed" />`,
})
class SidebarHost {
  readonly items = ITEMS.slice(0, 4);
  readonly collapsed = signal(false);
}

describe('Navigation', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  it('TabBar : 4 entrées max, cible de 56 px, safe area, masquée dès lg', async () => {
    const fixture = TestBed.createComponent(RjTabBar);
    fixture.componentRef.setInput('items', ITEMS);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const links = host.querySelectorAll('a');
    expect(links).toHaveLength(4);
    expect(links[0]?.className).toContain('h-14');
    const nav = host.querySelector('nav') as HTMLElement;
    expect(nav.getAttribute('aria-label')).toBe('Navigation principale');
    expect(nav.className).toContain('pb-safe');
    expect(nav.className).toContain('lg:hidden');
    expect(links[2]?.textContent).toContain('9+');
    expect(links[2]?.textContent).toContain('Alertes, 12 non lues');
  });

  it('Sidebar : 240 px, repliable à 72 px avec libellés conservés pour les lecteurs d’écran', async () => {
    const fixture = TestBed.createComponent(SidebarHost);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const aside = host.querySelector('aside') as HTMLElement;
    expect(aside.className).toContain('w-60');
    expect(aside.className).toContain('lg:flex');
    const toggle = host.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.collapsed()).toBe(true);
    expect(aside.className).toContain('w-18');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const label = host.querySelector('nav a span.sr-only');
    expect(label?.textContent).toBe('Analyser');
    expect(host.querySelector('nav a')?.getAttribute('title')).toBe('Analyser');
  });

  it('AppShell : header, contenu centré 1200 px, lien d’évitement et notifications', async () => {
    localStorage.removeItem('rj.sidebar.collapsed');
    const fixture = TestBed.createComponent(RjAppShell);
    fixture.componentRef.setInput('items', ITEMS.slice(0, 4));
    fixture.componentRef.setInput('notificationCount', 3);
    const clicks = vi.fn();
    fixture.componentInstance.notifications.subscribe(clicks);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const main = host.querySelector('main') as HTMLElement;
    expect(main.className).toContain('max-w-reading');
    expect(main.className).toContain('px-4');
    expect(main.className).toContain('md:px-6');
    expect(main.className).toContain('lg:px-8');
    expect(host.className).toContain('min-h-dvh');
    expect(host.querySelector('a[href="#rj-main"]')?.textContent).toContain('Aller au contenu');
    const bell = host.querySelector('button[aria-label^="Notifications"]') as HTMLButtonElement;
    expect(bell.getAttribute('aria-label')).toBe('Notifications, 3 non lues');
    bell.click();
    expect(clicks).toHaveBeenCalled();
    expect(host.querySelector('rj-tab-bar')).not.toBeNull();
    expect(host.querySelector('rj-sidebar')).not.toBeNull();
  });

  describe('AppShell : une seule navigation créée selon la largeur', () => {
    let listeners: ((event: MediaQueryListEvent) => void)[] = [];
    function mockWidth(desktop: boolean) {
      listeners = [];
      const matchMedia = vi.fn(
        (query: string) =>
          ({
            matches: desktop,
            media: query,
            addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.push(listener),
            removeEventListener: vi.fn(),
          }) as unknown as MediaQueryList,
      );
      Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: matchMedia });
    }
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    afterEach(() => {
      if (original) Object.defineProperty(window, 'matchMedia', original);
      else delete (window as { matchMedia?: unknown }).matchMedia;
    });

    it('mobile : barre d’onglets et logo du header, pas de barre latérale', async () => {
      mockWidth(false);
      const fixture = TestBed.createComponent(RjAppShell);
      fixture.componentRef.setInput('items', ITEMS.slice(0, 4));
      await fixture.whenStable();
      const host = fixture.nativeElement as HTMLElement;
      expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 64rem)');
      expect(host.querySelector('rj-tab-bar')).not.toBeNull();
      expect(host.querySelector('rj-sidebar')).toBeNull();
      expect(host.querySelector('header a[aria-label="Raijin Shield, accueil"]')).not.toBeNull();
    });

    it('desktop : barre latérale seule, puis bascule au redimensionnement', async () => {
      mockWidth(true);
      const fixture = TestBed.createComponent(RjAppShell);
      fixture.componentRef.setInput('items', ITEMS.slice(0, 4));
      await fixture.whenStable();
      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('rj-sidebar')).not.toBeNull();
      expect(host.querySelector('rj-tab-bar')).toBeNull();
      expect(host.querySelector('header a[aria-label="Raijin Shield, accueil"]')).toBeNull();
      listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent));
      await fixture.whenStable();
      expect(host.querySelector('rj-sidebar')).toBeNull();
      expect(host.querySelector('rj-tab-bar')).not.toBeNull();
    });
  });
});

describe('isNavItemActive', () => {
  it('même chemin ou sous-chemin, jamais un simple préfixe de texte', async () => {
    const { isNavItemActive } = await import('./nav-item');
    const compte = { label: 'Compte', path: '/compte', icon: 'compte' } as const;
    expect(isNavItemActive(compte, '/compte')).toBe(true);
    expect(isNavItemActive(compte, '/compte/securite')).toBe(true);
    expect(isNavItemActive(compte, '/comptes')).toBe(false);
    expect(isNavItemActive(compte, '/analyse')).toBe(false);
  });
});
