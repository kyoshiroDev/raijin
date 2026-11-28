import { afterNextRender, type Injector } from '@angular/core';

/** Après une tentative d'envoi invalide : focus sur le premier champ en erreur (lu avec son message). */
export function focusFirstInvalid(host: HTMLElement, injector: Injector): void {
  afterNextRender(() => host.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), { injector });
}

/**
 * Changement d'état majeur (formulaire envoyé, lien vérifié, échec) : la page remonte en haut et
 * le focus va sur le nouveau titre `h1` (tabindex -1, lu par les lecteurs d'écran). Sans cela, en
 * paysage mobile, la page reste défilée en bas et le titre n'est pas visible.
 */
export function focusPageTitle(host: HTMLElement, injector: Injector): void {
  afterNextRender(
    () => {
      const view = host.ownerDocument.defaultView;
      view?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      const title = host.querySelector<HTMLElement>('h1');
      if (!title) return;
      if (!title.hasAttribute('tabindex')) title.setAttribute('tabindex', '-1');
      // Pas d'anneau de focus sur un titre (focus programmatique, non interactif).
      title.classList.add('outline-none');
      title.focus({ preventScroll: true });
    },
    { injector },
  );
}
