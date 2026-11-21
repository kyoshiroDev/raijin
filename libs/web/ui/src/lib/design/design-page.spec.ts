import { TestBed } from '@angular/core/testing';
import { DesignPage } from './design-page';

describe('DesignPage', () => {
  it('affiche le titre de la page de design', async () => {
    await TestBed.configureTestingModule({ imports: [DesignPage] }).compileComponents();
    const fixture = TestBed.createComponent(DesignPage);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('h1')?.textContent).toContain('Design');
  });
});
