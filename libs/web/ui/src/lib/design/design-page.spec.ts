import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DesignPage } from './design-page';

describe('DesignPage', () => {
  it('affiche le titre et une section par composant de base', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPage], providers: [provideRouter([])] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPage);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('h1')?.textContent).toContain('Design');
    const sections = Array.from(host.querySelectorAll('section h2')).map((h) => h.textContent);
    expect(sections).toEqual(
      expect.arrayContaining(['Boutons', 'Verdicts', 'Cartes', 'Champs de saisie', 'Bottom sheet', 'Navigation', 'Toasts']),
    );
    expect(host.querySelectorAll('rj-verdict-badge').length).toBeGreaterThanOrEqual(6);
  });
});
