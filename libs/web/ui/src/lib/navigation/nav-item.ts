import { DestroyRef, inject, signal, type Signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { type RjIconName } from '../icon/icons';

/** Entrée de navigation partagée par la barre d'onglets (mobile) et la barre latérale (desktop). */
export interface RjNavItem {
  readonly label: string;
  readonly path: string;
  readonly icon: RjIconName;
  /** Compteur affiché en pastille (ex. alertes non lues). */
  readonly badge?: number;
}

/** Libellé accessible d'un compteur : « 3 nouvelles », plafonné visuellement à 9+. */
export function badgeText(count: number | undefined): string {
  if (!count || count <= 0) {
    return '';
  }
  return count > 9 ? '9+' : String(count);
}

/** Chemin courant (sans requête ni fragment), mis à jour à chaque fin de navigation. */
export function currentPath(): Signal<string> {
  const router = inject(Router);
  const path = signal(stripUrl(router.url));
  const subscription = router.events.subscribe((event) => {
    if (event instanceof NavigationEnd) path.set(stripUrl(event.urlAfterRedirects));
  });
  inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  return path.asReadonly();
}

/**
 * Entrée active : même chemin ou sous-chemin (`/compte/securite` active « Compte »), comme
 * `routerLinkActive` non exact. Un seul calcul par barre au lieu d'une directive par lien
 * (premier rendu plus court, docs/ARCHITECTURE.md §10).
 */
export function isNavItemActive(item: RjNavItem, path: string): boolean {
  const target = item.path.replace(/\/+$/, '') || '/';
  if (target === '/') return path === '/';
  return path === target || path.startsWith(`${target}/`);
}

function stripUrl(url: string): string {
  return url.split(/[?#]/, 1)[0] || '/';
}
