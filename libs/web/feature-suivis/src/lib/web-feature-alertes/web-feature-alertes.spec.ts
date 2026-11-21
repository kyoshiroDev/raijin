import { TestBed } from '@angular/core/testing';
import { WebFeatureAlertes } from './web-feature-alertes';

describe('WebFeatureAlertes', () => {
  it('affiche le titre de l’écran', async () => {
    const fixture = TestBed.createComponent(WebFeatureAlertes);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('h1')?.textContent).toContain('Alertes');
  });
});
