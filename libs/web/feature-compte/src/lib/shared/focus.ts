import { afterNextRender, type Injector } from '@angular/core';

/** Après une tentative d'envoi invalide : focus sur le premier champ en erreur (lu avec son message). */
export function focusFirstInvalid(host: HTMLElement, injector: Injector): void {
  afterNextRender(() => host.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), { injector });
}
