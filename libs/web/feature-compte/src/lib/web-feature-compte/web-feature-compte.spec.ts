import { TestBed } from '@angular/core/testing';
import { WebFeatureCompte } from './web-feature-compte';

describe('WebFeatureCompte', () => {
  it('affiche le titre de l’écran', async () => {
    await TestBed.configureTestingModule({ imports: [WebFeatureCompte] }).compileComponents();
    const fixture = TestBed.createComponent(WebFeatureCompte);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('h1')?.textContent).toContain('Compte');
  });
});
