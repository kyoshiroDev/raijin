import { Route } from '@angular/router';
import { webFeatureAnalyseRoutes, webFeaturePublicTokenRoutes } from '@raijin/web-feature-analyse';
import { DesignPage } from '@raijin/web-ui';
import { adminAreaGuard } from './admin-area.guard';

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
      {
        // Composants de l'espace admin (KPI, graphiques, tableaux, états des services), données fictives.
        path: '_design/admin',
        title: 'Design admin — Raijin',
        loadComponent: () => import('@raijin/web-feature-admin').then((m) => m.AdminDemoPage),
      },
    ]
  : [];

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'analyse' },
  // Écran d'arrivée et page publique : chargés avec le bundle initial (docs/ARCHITECTURE.md §10).
  // Une route lazy ajoutait une cascade de requêtes (chunk de la feature puis ses chunks partagés)
  // entre le démarrage d'Angular et l'élément LCP, soit ~0,6 s en 4G lente simulée.
  { path: 'analyse', title: 'Analyser — Raijin', children: webFeatureAnalyseRoutes },
  {
    // Page publique d'une analyse (partage, image Open Graph injectée par l'API).
    path: 't',
    children: webFeaturePublicTokenRoutes,
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
    // Titres par écran dans la feature ; l'onglet Compte renvoie vers la connexion si besoin (authGuard).
    path: 'compte',
    loadChildren: () =>
      import('@raijin/web-feature-compte').then((m) => m.webFeatureCompteRoutes),
  },
  {
    // Abonnement, retours de Checkout, simulation, fin d'essai (feature Compte, chargée à la demande).
    path: 'abonnement',
    loadChildren: () =>
      import('@raijin/web-feature-compte').then((m) => m.webFeatureAbonnementRoutes),
  },
  {
    // Espace admin : chunk à la demande (Chart.js compris), jamais au démarrage. Non-admin → 404 standard
    // (`canMatch` laisse passer la route `**`). Coque propre : pas de barre d'onglets ni de barre latérale de l'app.
    path: 'admin',
    canMatch: [adminAreaGuard],
    data: { appChrome: false },
    loadChildren: () => import('@raijin/web-feature-admin').then((m) => m.webFeatureAdminRoutes),
  },
  {
    // API en maintenance (503 `MAINTENANCE`, intercepteur de web-data-access).
    path: 'maintenance',
    title: 'Maintenance — Raijin',
    loadComponent: () => import('./pages/maintenance.page').then((m) => m.MaintenancePage),
  },
  ...devOnlyRoutes,
  {
    path: '**',
    title: 'Page introuvable — Raijin',
    loadComponent: () => import('./pages/not-found.page').then((m) => m.NotFoundPage),
  },
];
