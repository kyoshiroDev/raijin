import { loadContracts } from '../contracts';
import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { ATTRIBUTION_QUERY_PARAMS } from '@raijin/shared-contracts';
import { ATTRIBUTION_KEY, ATTRIBUTION_PARAMS, AttributionTracker } from './attribution';

function setup(url: string, referrer = '') {
  const parsed = new URL(url);
  const fakeDocument = {
    location: { search: parsed.search, pathname: parsed.pathname, origin: parsed.origin },
    referrer,
    defaultView: window,
  };
  TestBed.configureTestingModule({ providers: [{ provide: DOCUMENT, useValue: fakeDocument }] });
  return TestBed.inject(AttributionTracker);
}

beforeEach(() => sessionStorage.clear());

// Contrats (chunk à la demande) déjà chargés : les réponses se valident en microtâches.
beforeAll(() => loadContracts());

describe('AttributionTracker', () => {
  it('capture les UTM, la provenance externe et la page d’arrivée', async () => {
    const tracker = setup('https://app.raijinshield.com/analyse?utm_source=x&utm_medium=social&utm_campaign=lancement', 'https://x.com/post/1');
    await tracker.capture();
    expect(await tracker.read()).toEqual({
      utmSource: 'x',
      utmMedium: 'social',
      utmCampaign: 'lancement',
      referrer: 'https://x.com/post/1',
      landingPath: '/analyse',
    });
  });

  it('garde le premier contact', async () => {
    sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify({ utmSource: 'premier' }));
    const tracker = setup('https://app.raijinshield.com/?utm_source=second');
    await tracker.capture();
    expect(await tracker.read()).toEqual({ utmSource: 'premier' });
  });

  it('ignore la provenance interne et les visites sans signal', async () => {
    const tracker = setup('https://app.raijinshield.com/compte', 'https://app.raijinshield.com/analyse');
    await tracker.capture();
    expect(await tracker.read()).toBeUndefined();
  });

  it('écarte les valeurs hostiles sans perdre les autres', async () => {
    const tracker = setup(`https://app.raijinshield.com/?utm_source=ok&utm_medium=${'a'.repeat(300)}`, 'javascript:alert(1)');
    await tracker.capture();
    expect(await tracker.read()).toEqual({ utmSource: 'ok', landingPath: '/' });
  });

  it('rejette un stockage altéré', async () => {
    const tracker = setup('https://app.raijinshield.com/');
    sessionStorage.setItem(ATTRIBUTION_KEY, '{"referrer":"javascript:alert(1)"}');
    expect(await tracker.read()).toBeUndefined();
    sessionStorage.setItem(ATTRIBUTION_KEY, 'pas du json');
    expect(await tracker.read()).toBeUndefined();
  });

  it('venue de la landing : rj_ref et rj_lp priment sur le référent et le chemin de l’app', async () => {
    const tracker = setup(
      'https://app.raijinshield.com/compte/inscription?utm_source=google&rj_ref=https%3A%2F%2Fwww.google.com%2F&rj_lp=%2Fguides%2Fautorite-de-mint',
      'https://raijinshield.com/guides/autorite-de-mint',
    );
    await tracker.capture();
    expect(await tracker.read()).toEqual({
      utmSource: 'google',
      referrer: 'https://www.google.com/',
      landingPath: '/guides/autorite-de-mint',
    });
  });

  it('rj_lp seul suffit (visite directe de la landing), sinon repli sur le référent et le chemin', async () => {
    const tracker = setup('https://app.raijinshield.com/analyse?rj_lp=%2Ftarifs');
    await tracker.capture();
    expect(await tracker.read()).toEqual({ landingPath: '/tarifs' });
    sessionStorage.clear();
    TestBed.resetTestingModule();
    const fallback = setup('https://app.raijinshield.com/analyse?utm_medium=social', 'https://x.com/post/2');
    await fallback.capture();
    expect(await fallback.read()).toEqual({ utmMedium: 'social', referrer: 'https://x.com/post/2', landingPath: '/analyse' });
  });

  it('rj_ref et rj_lp hostiles sont ignorés sans perdre le reste', async () => {
    const tracker = setup(
      'https://app.raijinshield.com/?utm_source=ok&rj_ref=javascript%3Aalert(1)&rj_lp=%2F%2Fevil.example%2Fx',
    );
    await tracker.capture();
    expect(await tracker.read()).toEqual({ utmSource: 'ok' });
  });

  it('noms des paramètres alignés sur le contrat de la landing', () => {
    expect(ATTRIBUTION_PARAMS).toEqual(ATTRIBUTION_QUERY_PARAMS);
  });
});
