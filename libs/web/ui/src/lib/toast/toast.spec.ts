import { TestBed } from '@angular/core/testing';
import { RjToastHost } from './toast';
import { RjToastService } from './toast.service';

describe('Toasts', () => {
  afterEach(() => vi.useRealTimers());

  it('affiche un toast dans une région aria-live puis le retire après 4 s', async () => {
    const fixture = TestBed.createComponent(RjToastHost);
    const service = TestBed.inject(RjToastService);
    await fixture.whenStable();
    vi.useFakeTimers();
    service.show('Token ajouté à tes suivis.', { tone: 'success' });
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toContain('Token ajouté');
    vi.advanceTimersByTime(4000);
    expect(service.toasts()).toHaveLength(0);
  });

  it('garde trois toasts au plus et se ferme au bouton', async () => {
    const fixture = TestBed.createComponent(RjToastHost);
    const service = TestBed.inject(RjToastService);
    ['a', 'b', 'c', 'd'].forEach((m) => service.show(m, { duration: 0 }));
    expect(service.toasts().map((t) => t.message)).toEqual(['b', 'c', 'd']);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    (host.querySelector('button[aria-label="Fermer la notification"]') as HTMLButtonElement).click();
    expect(service.toasts().map((t) => t.message)).toEqual(['c', 'd']);
  });
});
