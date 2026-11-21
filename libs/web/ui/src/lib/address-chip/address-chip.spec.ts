import { TestBed } from '@angular/core/testing';
import { RjClipboard } from '../clipboard/clipboard';
import { RjAddressChip } from './address-chip';

const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function setup(copy: (text: string) => Promise<boolean>) {
  TestBed.configureTestingModule({ providers: [{ provide: RjClipboard, useValue: { copy, read: vi.fn() } }] });
  const fixture = TestBed.createComponent(RjAddressChip);
  fixture.componentRef.setInput('address', MINT);
  return fixture;
}

describe('RjAddressChip', () => {
  afterEach(() => vi.useRealTimers());

  it('affiche l’adresse tronquée au milieu, en mono, valeur complète en title', async () => {
    const fixture = setup(async () => true);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[title]') as HTMLElement;
    expect(text.getAttribute('title')).toBe(MINT);
    expect(text.className).toContain('tabular');
    expect(text.querySelector('[aria-hidden="true"]')?.textContent).toBe('7xKX…gAsU');
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Copier l’adresse');
  });

  it('copie l’adresse et affiche « Copié » puis revient à l’état initial', async () => {
    const copy = vi.fn(async () => true);
    const fixture = setup(copy);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    // Horloge simulée après le premier rendu : le planificateur zoneless s'appuie sur setTimeout.
    vi.useFakeTimers();
    await fixture.componentInstance.copy();
    fixture.detectChanges();
    expect(copy).toHaveBeenCalledWith(MINT);
    expect(host.querySelector('button')?.textContent).toContain('Copié');
    expect(host.querySelector('[aria-live]')?.textContent).toContain('Adresse copiée');
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
    expect(host.querySelector('button')?.textContent).not.toContain('Copié');
  });

  it('signale l’échec de copie', async () => {
    const fixture = setup(async () => false);
    await fixture.whenStable();
    await fixture.componentInstance.copy();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('button')?.textContent).toContain('Échec');
  });
});
