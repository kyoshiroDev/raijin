import { afterNextRender, type Injector } from '@angular/core';

/**
 * Changement d'étape de la 2FA (codes de secours, session expirée, nouveaux codes) : la page remonte en haut (ou
 * jusqu'à la cible) et le focus va sur le titre (tabindex -1, lu par les lecteurs d'écran). Sans cela, en paysage
 * mobile, la page reste défilée en bas après le formulaire et le titre n'est pas visible. Même principe que
 * `focusPageTitle` de feature-compte (phase 2).
 */
export function focusStepTitle(host: HTMLElement, injector: Injector, selector = 'h1', when: () => boolean = () => true): void {
  afterNextRender(
    () => {
      if (!when()) return;
      const title = host.querySelector<HTMLElement>(selector);
      const view = host.ownerDocument.defaultView;
      if (selector === 'h1' || !title) {
        view?.scrollTo?.({ top: 0, left: 0, behavior: 'instant' });
      } else {
        title.scrollIntoView?.({ block: 'start', behavior: 'instant' });
      }
      if (!title) return;
      if (!title.hasAttribute('tabindex')) title.setAttribute('tabindex', '-1');
      // Focus programmatique d'un titre non interactif : pas d'anneau de focus.
      title.classList.add('outline-none');
      title.focus({ preventScroll: true });
    },
    { injector },
  );
}
