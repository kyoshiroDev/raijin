import { TestBed } from '@angular/core/testing';
import { WebFeatureSuivis } from './web-feature-suivis';

describe('WebFeatureSuivis', () => {
  it('affiche le titre de l’écran', async () => {
    await TestBed.configureTestingModule({ imports: [WebFeatureSuivis] }).compileComponents();
    const fixture = TestBed.createComponent(WebFeatureSuivis);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('h1')?.textContent).toContain('Suivis');
  });
});
