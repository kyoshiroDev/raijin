import { TestBed } from '@angular/core/testing';
import { WebFeatureAnalyse } from './web-feature-analyse';

describe('WebFeatureAnalyse', () => {
  it('affiche le titre de l’écran', async () => {
    await TestBed.configureTestingModule({ imports: [WebFeatureAnalyse] }).compileComponents();
    const fixture = TestBed.createComponent(WebFeatureAnalyse);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('h1')?.textContent).toContain('Analyser');
  });
});
