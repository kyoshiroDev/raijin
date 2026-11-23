import { track } from './track';

const FAQ_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Événements liés à la page plutôt qu'à un clic (docs/ANALYTICS.md §3) :
 * - `faq_ouverte { faq_id }` à l'ouverture d'un `<details data-faq-id>` (l'événement `toggle` ne remonte pas :
 *   écoute en phase de capture), pas à la fermeture ;
 * - `voir_tarifs` à l'affichage d'une page qui porte `[data-track-view="voir_tarifs"]` (page Tarifs).
 * Sans consentement, `track` ne fait rien.
 */
export function bindPageEvents(doc: Document): void {
  doc.addEventListener(
    'toggle',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement) || !target.open) return;
      const id = target.dataset['faqId'] ?? '';
      if (FAQ_ID.test(id)) track('faq_ouverte', { faq_id: id });
    },
    { capture: true },
  );

  if (doc.querySelector('[data-track-view="voir_tarifs"]')) track('voir_tarifs');
}
