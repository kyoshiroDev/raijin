import type { Route } from '@angular/router';
import { BILLING_RETURN_PATHS } from '@raijin/shared-contracts';
import { authGuard, verifiedEmailGuard } from '@raijin/web-data-access';

/** Chemin relatif à `/abonnement` d'une page de retour fixe (contrat partagé avec l'API). */
export function billingPath(key: keyof typeof BILLING_RETURN_PATHS): string {
  return BILLING_RETURN_PATHS[key].replace(/^\/abonnement\/?/, '');
}

/**
 * Routes de l'abonnement (`/abonnement/...`, docs/ARCHITECTURE.md §13), toutes chargées à la demande.
 * `/abonnement` est visible sans compte (offres) ; le reste exige une session.
 */
export const webFeatureAbonnementRoutes: Route[] = [
  {
    path: billingPath('subscription'),
    pathMatch: 'full',
    title: 'Abonnement — Raijin',
    loadComponent: () => import('./subscription.page').then((m) => m.SubscriptionPage),
  },
  {
    path: billingPath('checkoutSuccess'),
    title: 'Abonnement confirmé — Raijin',
    canActivate: [authGuard],
    loadComponent: () => import('./checkout-success.page').then((m) => m.CheckoutSuccessPage),
  },
  {
    path: billingPath('simulatedCheckout'),
    title: 'Paiement simulé — Raijin',
    canActivate: [authGuard],
    loadComponent: () => import('./simulated-checkout.page').then((m) => m.SimulatedCheckoutPage),
  },
  {
    path: billingPath('simulatedPortal'),
    title: 'Portail simulé — Raijin',
    canActivate: [authGuard],
    loadComponent: () => import('./simulated-portal.page').then((m) => m.SimulatedPortalPage),
  },
  {
    path: 'fin-essai',
    title: 'Fin de l’essai Pro — Raijin',
    canActivate: [authGuard],
    loadComponent: () => import('./trial-end.page').then((m) => m.TrialEndPage),
  },
  {
    path: 'suivis',
    title: 'Suivis à garder — Raijin',
    canActivate: [verifiedEmailGuard],
    loadComponent: () => import('./keep-watches.page').then((m) => m.KeepWatchesPage),
  },
];
