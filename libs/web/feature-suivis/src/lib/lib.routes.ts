import { Route } from '@angular/router';
import { authGuard, verifiedEmailGuard } from '@raijin/web-data-access';

/**
 * Écran « Suivis » (`/suivis`). Connexion et e-mail confirmé exigés (l'API les exige aussi) :
 * sinon connexion avec retour, ou écran « Confirme ton adresse ».
 */
export const webFeatureSuivisRoutes: Route[] = [
  {
    path: '',
    canActivate: [verifiedEmailGuard],
    loadComponent: () => import('./suivis/suivis.page').then((m) => m.SuivisPage),
  },
];

/** Écran « Alertes », routé sur /alertes par apps/web : une session suffit (comme l'API). */
export const webFeatureAlertesRoutes: Route[] = [
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./alertes/alertes.page').then((m) => m.AlertesPage),
  },
];
