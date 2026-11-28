/**
 * Porte de démarrage de l'app (docs/ARCHITECTURE.md §10.7, contrat côté app).
 *
 * Sur `/t/<mint>` servie par l'API, `<rj-root>` contient déjà un verdict statique lisible
 * (`<main data-rj-static="t">`) : démarrer Angular pendant le chargement ne ferait qu'ajouter une
 * tâche longue. On attend donc la première interaction (pointeur, toucher, clavier, focus) pour
 * appeler `start()`. Partout ailleurs (autres routes, dev sans injection, URL avec paramètres
 * d'attribution `utm_*` ou toute autre recherche), `start()` est appelé tout de suite.
 *
 * Sans Angular : appelée par `apps/web/src/main.ts` avant `bootstrapApplication`.
 * Pas de minuterie de repli ni de démarrage au défilement (le comportement mesuré est celui des visiteurs).
 */

/** Événements qui déclenchent le démarrage différé. */
export const STARTUP_GATE_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'focusin'] as const;

/** Sélecteur du verdict statique injecté par l'API (contrat stable avec `renderStaticVerdict`). */
export const STATIC_VERDICT_SELECTOR = 'rj-root > [data-rj-static="t"]';

/** `/t/<mint>` (adresse base58 de 32 à 44 caractères), barre oblique finale tolérée. */
const PUBLIC_TOKEN_PATH = /^\/t\/[1-9A-HJ-NP-Za-km-z]{32,44}\/?$/;

/** Vrai si le démarrage doit attendre la première interaction. */
export function shouldDeferStartup(location: Pick<Location, 'pathname' | 'search'>, doc: Pick<Document, 'querySelector'>): boolean {
  return (
    PUBLIC_TOKEN_PATH.test(location.pathname) && location.search === '' && doc.querySelector(STATIC_VERDICT_SELECTOR) !== null
  );
}

/** Appelle `start()` une seule fois : tout de suite, ou à la première interaction sur `/t/<mint>` statique. */
export function startWhenInteractive(
  start: () => void,
  view: Window | null = globalThis.window ?? null,
): void {
  const doc = view?.document;
  if (!view || !doc || !shouldDeferStartup(view.location, doc)) {
    start();
    return;
  }
  const options: AddEventListenerOptions = { capture: true, passive: true, once: true };
  let started = false;
  const onInteraction = (): void => {
    if (started) return;
    started = true;
    for (const type of STARTUP_GATE_EVENTS) doc.removeEventListener(type, onInteraction, options);
    start();
  };
  for (const type of STARTUP_GATE_EVENTS) doc.addEventListener(type, onInteraction, options);
}
