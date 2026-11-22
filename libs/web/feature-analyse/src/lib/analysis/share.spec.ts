import { TestBed } from '@angular/core/testing';
import { RjClipboard } from '@raijin/web-ui';
import { AnalysisShare, publicTokenUrl } from './share';

const payload = { title: 'Verdict Raijin : Sain', text: 'texte', url: 'https://app.raijinshield.com/t/abc' };

function setup(copyResult = true) {
  const copy = vi.fn().mockResolvedValue(copyResult);
  TestBed.configureTestingModule({ providers: [{ provide: RjClipboard, useValue: { copy, read: vi.fn() } }] });
  return { service: TestBed.inject(AnalysisShare), copy };
}

describe('AnalysisShare', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('construit le lien public /t/<mint>', () => {
    expect(publicTokenUrl('https://app.raijinshield.com/', 'abc')).toBe('https://app.raijinshield.com/t/abc');
  });

  it('Web Share API disponible : feuille native', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    const { service, copy } = setup();
    expect(await service.share(payload)).toBe('shared');
    expect(share).toHaveBeenCalledWith(payload);
    expect(copy).not.toHaveBeenCalled();
  });

  it('partage annulé : rien n’est copié', async () => {
    Object.defineProperty(navigator, 'share', { value: vi.fn().mockRejectedValue(new DOMException('x', 'AbortError')), configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    const { service, copy } = setup();
    expect(await service.share(payload)).toBe('cancelled');
    expect(copy).not.toHaveBeenCalled();
  });

  it('partage refusé : repli sur la copie du lien', async () => {
    Object.defineProperty(navigator, 'share', { value: vi.fn().mockRejectedValue(new DOMException('x', 'NotAllowedError')), configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    const { service, copy } = setup();
    expect(await service.share(payload)).toBe('copied');
    expect(copy).toHaveBeenCalledWith(payload.url);
  });

  it('sans Web Share API : copie, ou échec signalé', async () => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    const ok = setup();
    expect(await ok.service.share(payload)).toBe('copied');
    TestBed.resetTestingModule();
    const ko = setup(false);
    expect(await ko.service.share(payload)).toBe('failed');
  });
});
