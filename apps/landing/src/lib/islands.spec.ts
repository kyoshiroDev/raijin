// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://raijinshield.com/"}
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANALYSE_FORM_ERRORS, bindAnalyseForm } from './analyse-form';
import { writeConsent } from './analytics/consent';
import { loadGa4 } from './analytics/ga4';
import { bindPageEvents } from './analytics/page-events';
import { clearCookies } from './analytics/test-fixtures';
import { bindDemo } from './demo/demo-island';
import { hasReadEnough } from './guide-read';

type W = Window & { dataLayer?: IArguments[]; gtag?: unknown; [k: string]: unknown };
const w = window as unknown as W;
const ID = 'G-TEST1234';

function events(): unknown[][] {
  return (w.dataLayer ?? []).map((args) => [...args]).filter((args) => args[0] === 'event');
}

function consent(): void {
  writeConsent(document, true);
  loadGa4(document, ID);
}

beforeEach(() => {
  clearCookies(document);
  delete w.dataLayer;
  delete w.gtag;
  document.head.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('champ d’analyse', () => {
  function form(): HTMLFormElement {
    document.body.innerHTML = `<form action="https://app.raijinshield.com/analyse" data-analyse-form>
      <input name="mint" maxlength="256" /><button type="button" data-paste hidden>Coller</button>
      <p data-error></p><button type="submit">Analyser</button></form>`;
    const element = document.querySelector('form') as HTMLFormElement;
    bindAnalyseForm(element);
    return element;
  }

  it('affiche une erreur accessible sur une saisie invalide, sans événement', () => {
    consent();
    const element = form();
    const input = element.querySelector('input') as HTMLInputElement;
    input.value = 'pas-une-adresse';
    element.requestSubmit();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(element.querySelector('[data-error]')?.textContent).toBe(ANALYSE_FORM_ERRORS.invalid);
    expect(events()).toEqual([]);
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });
});

describe('démonstration', () => {
  function demo(): HTMLElement {
    document.body.innerHTML = `<div data-demo="static" data-demo-verdict="warn">
      <div data-demo-overlay hidden><button type="button" data-demo-run>Lancer</button></div>
      <div data-demo-result tabindex="-1"></div></div>`;
    const root = document.querySelector<HTMLElement>('[data-demo]') as HTMLElement;
    bindDemo(root);
    return root;
  }

  it('masque le résultat puis le révèle et envoie analyse_demo_resultat avec consentement', () => {
    consent();
    const root = demo();
    expect(root.dataset['demo']).toBe('idle');
    expect((root.querySelector('[data-demo-overlay]') as HTMLElement).hidden).toBe(false);
    (root.querySelector('[data-demo-run]') as HTMLButtonElement).click();
    expect(root.dataset['demo']).toBe('done');
    expect(events()).toEqual([['event', 'analyse_demo_resultat', { verdict: 'warn' }]]);
  });

  it('n’envoie rien sans consentement', () => {
    const root = demo();
    (root.querySelector('[data-demo-run]') as HTMLButtonElement).click();
    expect(root.dataset['demo']).toBe('done');
    expect(w.dataLayer).toBeUndefined();
  });
});

describe('événements de page', () => {
  it('faq_ouverte à l’ouverture seulement, voir_tarifs sur la page Tarifs', () => {
    consent();
    document.body.innerHTML = `<div data-track-view="voir_tarifs"></div>
      <details data-faq-id="essai-pro"><summary>Q</summary><p>R</p></details>`;
    bindPageEvents(document);
    const details = document.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    expect(events()).toEqual([
      ['event', 'voir_tarifs', {}],
      ['event', 'faq_ouverte', { faq_id: 'essai-pro' }],
    ]);
  });
});

describe('lecture d’un guide', () => {
  it('compte une lecture au-delà de 60 % de l’article', () => {
    expect(hasReadEnough(100, 1000, 600)).toBe(false);
    expect(hasReadEnough(100, 1000, 700)).toBe(true);
    expect(hasReadEnough(0, 0, 700)).toBe(false);
  });
});
