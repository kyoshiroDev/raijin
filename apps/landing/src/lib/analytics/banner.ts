import { readConsent, writeConsent } from './consent';

export interface ConsentBannerOptions {
  /** Appelé après chaque choix explicite (accepter, refuser, enregistrer). */
  onChange: (analytics: boolean) => void;
  now?: () => Date;
}

export interface ConsentBannerHandle {
  open: (opener?: HTMLElement | null) => void;
  close: () => void;
  isOpen: () => boolean;
}

/**
 * Comportement de la bannière rendue par `components/consent/ConsentBanner.astro`.
 * - Première visite (ou choix expiré) : affichée sans voler le focus (elle est en tête du `<body>`).
 * - « Gérer les cookies » : rouverte, focus sur la bannière puis rendu à l'élément d'origine.
 * - Échap ferme la bannière **seulement** si un choix existe déjà : il ne vaut jamais acceptation.
 * - Le panneau « Personnaliser » reflète le choix courant ; l'interrupteur est éteint par défaut.
 */
export function initConsentBanner(
  doc: Document,
  banner: HTMLElement,
  { onChange, now = () => new Date() }: ConsentBannerOptions,
): ConsentBannerHandle {
  const panel = banner.querySelector<HTMLElement>('[data-consent-panel]');
  const toggle = banner.querySelector<HTMLInputElement>('[data-consent-analytics]');
  const customize = banner.querySelector<HTMLButtonElement>('[data-consent-action="customize"]');
  const save = banner.querySelector<HTMLButtonElement>('[data-consent-action="save"]');
  let opener: HTMLElement | null = null;

  const setPanel = (expanded: boolean) => {
    if (panel) panel.hidden = !expanded;
    if (save) save.hidden = !expanded;
    customize?.setAttribute('aria-expanded', String(expanded));
    if (expanded && toggle) toggle.checked = readConsent(doc, now())?.analytics === true;
  };

  const handle: ConsentBannerHandle = {
    open(from) {
      opener = from ?? null;
      setPanel(false);
      banner.hidden = false;
      if (from) banner.focus();
    },
    close() {
      banner.hidden = true;
      setPanel(false);
      const target = opener;
      opener = null;
      target?.focus();
    },
    isOpen: () => !banner.hidden,
  };

  const decide = (analytics: boolean) => {
    writeConsent(doc, analytics, now());
    handle.close();
    onChange(analytics);
  };

  banner.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-consent-action]') : null;
    switch (button?.getAttribute('data-consent-action')) {
      case 'accept':
        decide(true);
        break;
      case 'refuse':
        decide(false);
        break;
      case 'save':
        decide(toggle?.checked === true);
        break;
      case 'customize':
        setPanel(panel?.hidden !== false);
        if (panel && !panel.hidden) toggle?.focus();
        break;
      default:
        break;
    }
  });

  banner.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && readConsent(doc, now()) !== null) {
      event.preventDefault();
      handle.close();
    }
  });

  for (const link of doc.querySelectorAll<HTMLElement>('[data-consent-open]')) {
    link.hidden = false;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      handle.open(link);
    });
  }

  if (readConsent(doc, now()) === null) handle.open();
  return handle;
}
