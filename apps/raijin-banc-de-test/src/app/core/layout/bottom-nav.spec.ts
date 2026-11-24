import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { BottomNav } from './bottom-nav';

@Component({ template: '' })
class Blank {}

describe('BottomNav', () => {
  async function renderAt(url: string) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: Blank, pathMatch: 'full' },
          { path: 'alerts', component: Blank },
          { path: 'portfolio', component: Blank },
          { path: 'performance', component: Blank },
          { path: 'settings', component: Blank },
        ]),
      ],
    });
    const fixture = TestBed.createComponent(BottomNav);
    await TestBed.inject(Router).navigateByUrl(url);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const links = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>('nav a'));
    return { fixture, links };
  }

  it('renders the 5 tabs with labels and links, inside a labelled nav', async () => {
    const { fixture, links } = await renderAt('/');
    expect((fixture.nativeElement as HTMLElement).querySelector('nav')?.getAttribute('aria-label')).toBe('Navigation principale');
    expect(links.map((a) => a.textContent?.trim())).toEqual(['Opportunités', 'Alertes', 'Portefeuille', 'Performance', 'Réglages']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/', '/alerts', '/portfolio', '/performance', '/settings']);
    for (const a of links) expect(a.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks only the home tab as current on "/" (exact match)', async () => {
    const { links } = await renderAt('/');
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual(['page', null, null, null, null]);
  });

  it('marks the Alertes tab as current on /alerts', async () => {
    const { links } = await renderAt('/alerts');
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null, null, null]);
    expect(links[1]!.classList).toContain('active');
  });

  it('marks the Performance tab as current on /performance', async () => {
    const { links } = await renderAt('/performance');
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, null, null, 'page', null]);
  });

  it('marks the Portefeuille tab as current on /portfolio', async () => {
    const { links } = await renderAt('/portfolio');
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, null, 'page', null, null]);
  });

  it('fits 5 tabs at 375 px: 5 equal columns (75 px ≥ 44 px), 56 px tall targets, 10 px labels that truncate instead of overflowing', async () => {
    const { fixture, links } = await renderAt('/');
    expect(links).toHaveLength(5);
    expect(375 / links.length).toBeGreaterThanOrEqual(44);
    expect((fixture.nativeElement as HTMLElement).querySelector('nav ul')?.classList).toContain('grid-cols-5');
    for (const a of links) {
      expect(a.classList).toContain('h-nav'); // 3.5rem = 56 px ≥ 44 px
      expect(a.classList).toContain('min-w-0');
      expect(a.querySelector('span')?.classList).toContain('truncate');
      expect(a.classList).toContain('text-micro');
    }
  });

  it('marks the Réglages tab as current on /settings', async () => {
    const { links } = await renderAt('/settings');
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, null, null, null, 'page']);
  });
});
