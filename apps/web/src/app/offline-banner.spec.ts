import { TestBed } from '@angular/core/testing';
import { RjOfflineBanner } from './offline-banner';

describe('RjOfflineBanner', () => {
  let onLine: { mockReturnValue(value: boolean): unknown; mockRestore(): void };

  beforeEach(() => {
    onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
  });

  afterEach(() => onLine.mockRestore());

  async function render() {
    const fixture = TestBed.createComponent(RjOfflineBanner);
    await fixture.whenStable();
    return fixture;
  }

  it('en ligne : rien d’affiché, région annoncée présente', async () => {
    const fixture = await render();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('status');
    expect(host.querySelector('[data-offline]')).toBeNull();
  });

  it('passe hors ligne puis revient : le bandeau apparaît puis disparaît', async () => {
    const fixture = await render();
    const host = fixture.nativeElement as HTMLElement;

    onLine.mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await fixture.whenStable();
    expect(host.querySelector('[data-offline]')?.textContent).toContain('Tu es hors ligne.');

    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await fixture.whenStable();
    expect(host.querySelector('[data-offline]')).toBeNull();
  });

  it('déjà hors ligne au chargement : bandeau affiché tout de suite', async () => {
    onLine.mockReturnValue(false);
    const fixture = await render();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-offline]')).not.toBeNull();
  });
});
