import { DestroyRef, effect, inject, untracked, type Signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { NavigationEnd, Router } from '@angular/router';

/**
 * Titre d'onglet dynamique : appliqué dès qu'il change, et réappliqué après chaque fin de
 * navigation (la stratégie de titre du routeur écrit le titre statique de la route après
 * l'activation du composant). `null` laisse le titre de la route.
 */
export function bindPageTitle(text: Signal<string | null>): void {
  const title = inject(Title);
  const apply = () => {
    const value = untracked(text);
    if (value) title.setTitle(value);
  };
  effect(() => {
    if (text()) apply();
  });
  const subscription = inject(Router).events.subscribe((event) => {
    if (event instanceof NavigationEnd) apply();
  });
  inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
}
