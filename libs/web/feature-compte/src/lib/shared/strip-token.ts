import { Location } from '@angular/common';
import { inject } from '@angular/core';
import { Router } from '@angular/router';

/**
 * Retire `?token=` de l'URL affichée (historique, partage d'écran, en-tête Referer) **sans
 * navigation** : la route courante et son composant restent en place (le lien magique et la page
 * de demande partagent le même chemin, distingués par la présence du jeton).
 * À appeler dans un contexte d'injection ; renvoie la fonction à exécuter.
 */
export function injectStripToken(): () => void {
  const location = inject(Location);
  const router = inject(Router);
  return () => {
    const tree = router.parseUrl(location.path(true));
    if (!('token' in tree.queryParams)) return;
    const rest = { ...tree.queryParams };
    delete rest['token'];
    tree.queryParams = rest;
    location.replaceState(router.serializeUrl(tree));
  };
}
