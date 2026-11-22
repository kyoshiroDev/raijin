import { Route } from '@angular/router';

/**
 * Écran « Scan de wallet » (`/wallet`), chargé à la demande. Pas de garde : un visiteur ou un
 * compte Gratuit voit l'explication du scan (l'API exige une session Pro ou un essai Pro).
 * L'adresse scannée n'est jamais dans l'URL (docs/ARCHITECTURE.md §12.2).
 */
export const webFeatureWalletRoutes: Route[] = [
  {
    path: '',
    loadComponent: () => import('./wallet/wallet.page').then((m) => m.WalletPage),
  },
];
