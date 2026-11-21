import { TestBed } from '@angular/core/testing';
import { WebFeatureWallet } from './web-feature-wallet';

describe('WebFeatureWallet', () => {
  it('affiche le titre de l’écran', async () => {
    await TestBed.configureTestingModule({ imports: [WebFeatureWallet] }).compileComponents();
    const fixture = TestBed.createComponent(WebFeatureWallet);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('h1')?.textContent).toContain('Scan de wallet');
  });
});
