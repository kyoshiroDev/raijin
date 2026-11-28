// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://raijinshield.com/"}
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureFromLocation,
  decorateAppUrl,
  persistAttribution,
  readStoredAttribution,
  resolveAttribution,
  sanitizeAttribution,
} from './attribution';
import { bootAnalytics } from './boot';
import { readCookie } from './cookies';
import { writeConsent } from './consent';
import { clearCookies, renderPage } from './test-fixtures';

const ORIGIN = 'https://raijinshield.com';
const ID = 'G-TEST1234';

function visit(path: string, referrer = '') {
  history.replaceState(null, '', path);
  Object.defineProperty(document, 'referrer', { value: referrer, configurable: true });
}

beforeEach(() => {
  clearCookies(document);
  sessionStorage.clear();
});
afterEach(() => visit('/'));

describe('relevé de première visite', () => {
  it('UTM, référent externe (origine + chemin) et page d’arrivée', () => {
    expect(
      captureFromLocation(
        { href: `${ORIGIN}/guides/rug?utm_source=x&utm_medium=social&utm_campaign=lancement&other=1`, origin: ORIGIN },
        'https://www.google.com/search?q=raijin',
      ),
    ).toEqual({
      utmSource: 'x',
      utmMedium: 'social',
      utmCampaign: 'lancement',
      referrer: 'https://www.google.com/search',
      landingPath: '/guides/rug',
    });
  });

  it('ignore le référent interne et ne retient rien sans signal', () => {
    expect(captureFromLocation({ href: `${ORIGIN}/tarifs`, origin: ORIGIN }, `${ORIGIN}/`)).toBeNull();
    expect(captureFromLocation({ href: `${ORIGIN}/`, origin: ORIGIN }, '')).toBeNull();
  });

  it('écarte les valeurs hostiles (contrôle, trop longues, schéma non http)', () => {
    const long = 'a'.repeat(201);
    expect(
      captureFromLocation({ href: `${ORIGIN}/?utm_source=%01bad&utm_medium=${long}&utm_campaign=ok`, origin: ORIGIN }, 'javascript:alert(1)'),
    ).toEqual({ utmCampaign: 'ok', landingPath: '/' });
    expect(sanitizeAttribution({ referrer: 'https://x.test/a?b=c', landingPath: '//evil', utmSource: 'ok', extra: 1 })).toEqual({
      utmSource: 'ok',
    });
    expect(sanitizeAttribution('nope')).toBeNull();
  });
});

describe('stockage selon le consentement', () => {
  it('sans consentement : sessionStorage uniquement, aucun cookie rj_attr', () => {
    visit('/?utm_source=newsletter', '');
    const value = resolveAttribution(document, false);
    expect(value).toEqual({ utmSource: 'newsletter', landingPath: '/' });
    expect(readCookie(document, 'rj_attr')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('rj.attribution') ?? '{}')).toEqual(value);
  });

  it('après consentement : cookie rj_attr de 90 jours, session vidée', () => {
    const writes: string[] = [];
    const store = new Map<string, string>();
    const fake = {
      location: { protocol: 'https:', hostname: 'raijinshield.com' },
      defaultView: { sessionStorage: { removeItem: (k: string) => store.delete(k), setItem: (k: string, v: string) => store.set(k, v) } },
      get cookie() {
        return '';
      },
      set cookie(v: string) {
        writes.push(v);
      },
    } as unknown as Document;
    persistAttribution(fake, { utmSource: 'x' }, true);
    expect(writes[0]).toBe(
      `rj_attr=${encodeURIComponent('{"utmSource":"x"}')}; Max-Age=${90 * 86_400}; Path=/; SameSite=Lax; Secure`,
    );
  });

  it('premier contact conservé : une nouvelle visite ne remplace pas l’attribution', () => {
    visit('/?utm_source=premier');
    resolveAttribution(document, false);
    visit('/tarifs?utm_source=second', 'https://autre.test/');
    expect(resolveAttribution(document, false)?.utmSource).toBe('premier');
  });

  it('acceptation dans la bannière : la session passe dans le cookie ; refus ensuite : cookie supprimé', () => {
    visit('/?utm_source=reddit');
    renderPage(document, ID);
    bootAnalytics(document);
    expect(readCookie(document, 'rj_attr')).toBeNull();
    document.querySelector<HTMLElement>('[data-consent-action="accept"]')?.click();
    expect(JSON.parse(readCookie(document, 'rj_attr') ?? '{}')).toEqual({ utmSource: 'reddit', landingPath: '/' });
    expect(sessionStorage.getItem('rj.attribution')).toBeNull();

    document.querySelector<HTMLElement>('[data-consent-open]')?.click();
    document.querySelector<HTMLElement>('[data-consent-action="refuse"]')?.click();
    expect(readCookie(document, 'rj_attr')).toBeNull();
    expect(readStoredAttribution(document)).toEqual({ utmSource: 'reddit', landingPath: '/' });
  });

  it('cookie ignoré sans identifiant GA4 (aucun consentement possible)', () => {
    writeConsent(document, true);
    visit('/?utm_source=x');
    renderPage(document, null);
    bootAnalytics(document);
    expect(readCookie(document, 'rj_attr')).toBeNull();
  });
});

describe('liens vers l’app', () => {
  it('ajoute utm_*, rj_ref, rj_lp sans écraser les paramètres existants', () => {
    const url = new URL(
      decorateAppUrl(
        'https://app.raijinshield.com/inscription?utm_source=landing',
        { utmSource: 'x', utmMedium: 'social', referrer: 'https://t.co/', landingPath: '/guides/rug' },
      ),
    );
    expect(url.searchParams.get('utm_source')).toBe('landing');
    expect(url.searchParams.get('utm_medium')).toBe('social');
    expect(url.searchParams.get('rj_ref')).toBe('https://t.co/');
    expect(url.searchParams.get('rj_lp')).toBe('/guides/rug');
    expect(decorateAppUrl('https://app.raijinshield.com/analyse', null)).toBe('https://app.raijinshield.com/analyse');
  });

  it('décore les liens data-app-link au démarrage, pas les autres', () => {
    visit('/guides/rug?utm_campaign=c1', 'https://x.com/post');
    renderPage(
      document,
      null,
      '<a id="app" data-app-link href="https://app.raijinshield.com/inscription">Essai</a><a id="other" href="/tarifs">Tarifs</a>',
    );
    bootAnalytics(document);
    const href = new URL(document.getElementById('app')?.getAttribute('href') ?? '');
    expect(href.searchParams.get('utm_campaign')).toBe('c1');
    expect(href.searchParams.get('rj_ref')).toBe('https://x.com/post');
    expect(href.searchParams.get('rj_lp')).toBe('/guides/rug');
    expect(document.getElementById('other')?.getAttribute('href')).toBe('/tarifs');
  });
});
