import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/** Même seuil que le préfixe Tailwind `lg` (64rem = 1024 px) : barre latérale au-delà, onglets en dessous. */
export const DESKTOP_MEDIA_QUERY = '(min-width: 64rem)';

/**
 * Largeur ≥ `lg`, lue **synchroniquement** au premier rendu (`matchMedia`) puis suivie au
 * redimensionnement. `null` si `matchMedia` n'existe pas (tests, vieux navigateurs) : les deux
 * navigations sont alors rendues et le CSS (`lg:hidden`, `hidden lg:flex`) choisit.
 * Évite de créer la barre latérale sur mobile (et la barre d'onglets sur desktop) au démarrage.
 * À appeler dans un contexte d'injection.
 */
export function desktopViewport(): Signal<boolean | null> {
  const view = inject(DOCUMENT).defaultView;
  const query = typeof view?.matchMedia === 'function' ? view.matchMedia(DESKTOP_MEDIA_QUERY) : null;
  const desktop = signal<boolean | null>(query ? query.matches : null);
  if (query) {
    const onChange = (event: MediaQueryListEvent) => desktop.set(event.matches);
    query.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => query.removeEventListener('change', onChange));
  }
  return desktop.asReadonly();
}
