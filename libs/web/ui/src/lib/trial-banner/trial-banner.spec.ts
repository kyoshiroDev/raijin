import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RjTrialBanner } from './trial-banner';

@Component({
  imports: [RjTrialBanner],
  template: `<rj-trial-banner text="Essai Pro : plus que 3 jours" linkLabel="Voir les offres" linkPath="/abonnement" (dismiss)="closed.set(true)" />`,
})
class Host {
  readonly closed = signal(false);
}

describe('RjTrialBanner', () => {
  it('affiche le texte, le lien et un bouton de fermeture accessible, sans animation', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const banner = host.querySelector('rj-trial-banner') as HTMLElement;
    expect(banner.getAttribute('role')).toBe('region');
    expect(banner.className).toContain('bg-thunder-soft');
    expect(banner.className).not.toMatch(/animate-/);
    expect(host.textContent).toContain('Essai Pro : plus que 3 jours');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/abonnement');
    const close = host.querySelector<HTMLButtonElement>('button[aria-label]');
    expect(close?.getAttribute('aria-label')).toContain('demain');
    close?.click();
    expect(fixture.componentInstance.closed()).toBe(true);
  });
});
