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
    expect(links[2]?.textContent).toContain('12 non lues');
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
});
