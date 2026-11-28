// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://raijinshield.com/"}
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootAnalytics } from './boot';
import { readConsent, writeConsent } from './consent';
import { readCookie } from './cookies';
import { loadGa4, normalizeMeasurementId } from './ga4';
import { clearCookies, googleScripts, renderPage } from './test-fixtures';
import { track, trackFromElement } from './track';

const ID = 'G-TEST1234';
type W = Window & { dataLayer?: IArguments[]; gtag?: unknown; [k: string]: unknown };
const w = window as unknown as W;

function layer(): unknown[][] {
  return (w.dataLayer ?? []).map((args) => [...args]);
}
function click(selector: string) {
  document.querySelector<HTMLElement>(selector)?.click();
}
function banner() {
  return document.getElementById('rj-consent') as HTMLElement;
}

beforeEach(() => {
  clearCookies(document);
  sessionStorage.clear();
  delete w.dataLayer;
  delete w.gtag;
  delete w[`ga-disable-${ID}`];
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('identifiant GA4', () => {
  it('accepte G-XXXX et rejette le reste', () => {
    expect(normalizeMeasurementId(' G-ABC123 ')).toBe('G-ABC123');
    for (const bad of [undefined, null, '', 'UA-1234-1', 'G-<script>', 'G-abc1234']) {
      expect(normalizeMeasurementId(bad)).toBeNull();
    }
  });
});

describe('aucun script Google avant acceptation', () => {
  it('sans identifiant GA4 : ni bannière, ni gtag, ni lien « Gérer les cookies »', () => {
    renderPage(document, null);
    const boot = bootAnalytics(document);
    expect(boot.banner).toBeNull();
    expect(document.getElementById('rj-consent')).toBeNull();
    expect(document.querySelector('[data-consent-open]')).toBeNull();
    expect(googleScripts(document)).toHaveLength(0);
    expect(w.gtag).toBeUndefined();
  });

  it('première visite : bannière affichée, rien de chargé, aucun dataLayer', () => {
    renderPage(document, ID);
    bootAnalytics(document);
    expect(banner().hidden).toBe(false);
    expect(googleScripts(document)).toHaveLength(0);
    expect(w.dataLayer).toBeUndefined();
    expect(w.gtag).toBeUndefined();
    expect(document.activeElement).toBe(document.body);
  });

  it('Échap à la première visite ne vaut pas acceptation', () => {
    renderPage(document, ID);
    bootAnalytics(document);
    banner().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(banner().hidden).toBe(false);
    expect(readConsent(document)).toBeNull();
    expect(googleScripts(document)).toHaveLength(0);
  });

  it('« Tout accepter » : Consent Mode v2 basique puis gtag.js injecté', () => {
    renderPage(document, ID);
    bootAnalytics(document);
    click('[data-consent-action="accept"]');
    expect(banner().hidden).toBe(true);
    expect(readConsent(document)?.analytics).toBe(true);
    const scripts = googleScripts(document);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe(`https://www.googletagmanager.com/gtag/js?id=${ID}`);
    expect(scripts[0]?.async).toBe(true);
    const calls = layer();
    expect(calls[0]).toEqual([
      'consent',
      'default',
      { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' },
    ]);
    expect(calls[1]).toEqual(['consent', 'update', { analytics_storage: 'granted' }]);
    expect(calls[3]).toEqual(['config', ID, { allow_google_signals: false, allow_ad_personalization_signals: false }]);
  });

  it('chargement idempotent', () => {
    renderPage(document, ID);
    loadGa4(document, ID);
    loadGa4(document, ID);
    expect(googleScripts(document)).toHaveLength(1);
  });
});

describe('refus et retour sur le choix', () => {
  it('« Tout refuser » : choix mémorisé, rien chargé, bannière non reproposée', () => {
    renderPage(document, ID);
    bootAnalytics(document);
    click('[data-consent-action="refuse"]');
    expect(readConsent(document)?.analytics).toBe(false);
    expect(googleScripts(document)).toHaveLength(0);

    renderPage(document, ID);
    bootAnalytics(document);
    expect(banner().hidden).toBe(true);
    expect(googleScripts(document)).toHaveLength(0);
  });

  it('choix accepté mémorisé : GA4 chargé au retour sans bannière', () => {
    writeConsent(document, true);
    renderPage(document, ID);
    bootAnalytics(document);
    expect(banner().hidden).toBe(true);
    expect(googleScripts(document)).toHaveLength(1);
  });

  it('« Gérer les cookies » rouvre la bannière, Échap la referme et rend le focus', () => {
    writeConsent(document, false);
    renderPage(document, ID);
    bootAnalytics(document);
    const manage = document.querySelector<HTMLButtonElement>('[data-consent-open]');
    expect(manage?.hidden).toBe(false);
    manage?.focus();
    manage?.click();
    expect(banner().hidden).toBe(false);
    expect(document.activeElement).toBe(banner());
    banner().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(banner().hidden).toBe(true);
    expect(document.activeElement).toBe(manage);
    expect(readConsent(document)?.analytics).toBe(false);
  });

  it('« Personnaliser » : interrupteur éteint par défaut, enregistrement explicite', () => {
    renderPage(document, ID);
    bootAnalytics(document);
    const customize = document.querySelector<HTMLButtonElement>('[data-consent-action="customize"]');
    const toggle = document.querySelector<HTMLInputElement>('[data-consent-analytics]');
    const panel = document.querySelector<HTMLElement>('[data-consent-panel]');
    customize?.click();
    expect(panel?.hidden).toBe(false);
    expect(customize?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.checked).toBe(false);
    click('[data-consent-action="save"]');
    expect(readConsent(document)?.analytics).toBe(false);
    expect(googleScripts(document)).toHaveLength(0);
  });

  it('retrait du consentement : envois coupés et cookies _ga supprimés', () => {
    writeConsent(document, true);
    renderPage(document, ID);
    bootAnalytics(document);
    document.cookie = '_ga=GA1.1.123; Path=/';
    document.cookie = '_ga_TEST1234=GS1.1; Path=/';
    click('[data-consent-open]');
    click('[data-consent-action="customize"]');
    const toggle = document.querySelector<HTMLInputElement>('[data-consent-analytics]');
    expect(toggle?.checked).toBe(true);
    if (toggle) toggle.checked = false;
    click('[data-consent-action="save"]');
    expect(w[`ga-disable-${ID}`]).toBe(true);
    expect(readCookie(document, '_ga')).toBeNull();
    expect(readCookie(document, '_ga_TEST1234')).toBeNull();
    expect(track('voir_tarifs')).toBe(false);
  });
});

describe('track()', () => {
  it('no-op sans consentement : aucun envoi, aucune file', () => {
    renderPage(document, ID);
    bootAnalytics(document);
    expect(track('cta_essai_clic', { emplacement: 'hero' })).toBe(false);
    expect(w.dataLayer).toBeUndefined();
  });

  it('no-op si le consentement existe mais que GA4 n’est pas chargé', () => {
    writeConsent(document, true);
    expect(track('voir_tarifs')).toBe(false);
  });

  it('envoie un événement typé après acceptation', () => {
    renderPage(document, ID);
    bootAnalytics(document);
    click('[data-consent-action="accept"]');
    expect(track('analyse_demo_resultat', { verdict: 'warn' })).toBe(true);
    expect(layer().at(-1)).toEqual(['event', 'analyse_demo_resultat', { verdict: 'warn' }]);
  });

  it('suivi déclaratif data-track : liste fermée et paramètres validés', () => {
    renderPage(
      document,
      ID,
      '<a id="ok" href="#" data-track="cta_essai_clic" data-track-emplacement="hero">Essai</a>' +
        '<a id="bad" href="#" data-track="cta_essai_clic" data-track-emplacement="ailleurs">x</a>' +
        '<a id="unknown" href="#" data-track="page_view">x</a>' +
        '<button id="faq" data-track="faq_ouverte" data-track-faq-id="prix">Q</button>',
    );
    bootAnalytics(document);
    click('#ok');
    expect(w.dataLayer).toBeUndefined();
    click('[data-consent-action="accept"]');
    click('#ok');
    expect(layer().at(-1)).toEqual(['event', 'cta_essai_clic', { emplacement: 'hero' }]);
    const before = layer().length;
    expect(trackFromElement(document, document.getElementById('bad') as Element)).toBe(false);
    expect(trackFromElement(document, document.getElementById('unknown') as Element)).toBe(false);
    expect(layer()).toHaveLength(before);
    click('#faq');
    expect(layer().at(-1)).toEqual(['event', 'faq_ouverte', { faq_id: 'prix' }]);
  });
});
