import { Route } from '@angular/router';
import { DesignPage } from '@raijin/web-ui';

/**
 * Page de référence visuelle, disponible uniquement en développement.
 * `ngDevMode` vaut `false` dans les builds de production : la route et son chunk sont retirés du bundle.
 */
const devOnlyRoutes: Route[] =
  typeof ngDevMode === 'undefined' || ngDevMode
  ? [
      {
        path: '_design',
        title: 'Design — Raijin',
        // web-ui est déjà dans le bundle initial (coquille) : référence statique, retirée en prod
        // avec cette branche morte (ngDevMode === false), DesignPage est alors éliminé par tree-shaking.
        component: DesignPage,
      },
    ]
  : [];

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'analyse' },
  {
    path: 'analyse',
    title: 'Analyser — Raijin',
    loadChildren: () =>
      import('@raijin/web-feature-analyse').then((m) => m.webFeatureAnalyseRoutes),
  },
  {
    path: 'suivis',
    title: 'Suivis — Raijin',
    loadChildren: () =>
      import('@raijin/web-feature-suivis').then((m) => m.webFeatureSuivisRoutes),
  },
  {
    // Les alertes vivent dans la feature « suivis » (docs/ARCHITECTURE.md), écran dédié.
    path: 'alertes',
    title: 'Alertes — Raijin',
    loadChildren: () =>
      import('@raijin/web-feature-suivis').then((m) => m.webFeatureAlertesRoutes),
  },
  {
    path: 'wallet',
    title: 'Wallet — Raijin',
    loadChildren: () =>
      import('@raijin/web-feature-wallet').then((m) => m.webFeatureWalletRoutes),
  },
  {
    path: 'compte',
    title: 'Compte — Raijin',
    loadChildren: () =>
      import('@raijin/web-feature-compte').then((m) => m.webFeatureCompteRoutes),
  },
  ...devOnlyRoutes,
  { path: '**', redirectTo: 'analyse' },
];
