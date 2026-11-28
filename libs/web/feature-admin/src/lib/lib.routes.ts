import { type Route } from '@angular/router';
import { AdminShell } from './shell/admin-shell';
import { adminSessionGuard, enrollmentGuard, verifyGuard } from './shell/admin-guards';


/** Démonstration des composants, en développement seulement (retirée des builds de production). */
const devOnlyChildren: Route[] =
  typeof ngDevMode === 'undefined' || ngDevMode
    ? [
        {
          path: 'demo',
          title: 'Composants — Admin Raijin',
          loadComponent: () => import('./ui/demo/admin-demo.page').then((m) => m.AdminDemoPage),
        },
      ]
    : [];

/**
 * Espace admin (`/admin`, chargé à la demande ; la garde de l'app vérifie déjà connexion et rôle côté front).
 * - `securite/*` : activation de la 2FA, saisie du code, codes de secours (hors coque) ;
 * - le reste dans la coque, derrière `adminSessionGuard` (session admin vérifiée).
 *
 * **Pages (admin-analytics)** : remplacer `loadComponent: placeholder` (et `data`) de la ligne de l'écran par
 * `loadComponent: () => import('./pages/<écran>/<écran>.page').then((m) => m.<Écran>Page)`.
 */
export const webFeatureAdminRoutes: Route[] = [
  {
    path: 'securite',
    loadComponent: () => import('./security/security-layout').then((m) => m.AdminSecurityLayout),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'code' },
      {
        path: 'activation',
        title: 'Double authentification — Admin Raijin',
        canActivate: [enrollmentGuard],
        loadComponent: () => import('./security/enrollment.page').then((m) => m.AdminEnrollmentPage),
      },
      {
        path: 'code',
        title: 'Code admin — Raijin',
        canActivate: [verifyGuard],
        loadComponent: () => import('./security/verify.page').then((m) => m.AdminVerifyPage),
      },
      {
        path: 'codes-de-secours',
        title: 'Codes de secours — Admin Raijin',
        loadComponent: () => import('./security/recovery-codes.page').then((m) => m.AdminRecoveryCodesPage),
      },
    ],
  },
  {
    path: '',
    component: AdminShell,
    canActivate: [adminSessionGuard],
    canActivateChild: [adminSessionGuard],
    children: [
      { path: '', pathMatch: 'full', title: 'Vue d’ensemble — Admin Raijin', loadComponent: () => import('./pages/overview/overview.page').then((m) => m.AdminOverviewPage) },
      { path: 'trafic', title: 'Trafic — Admin Raijin', loadComponent: () => import('./pages/traffic/traffic.page').then((m) => m.AdminTrafficPage) },
      { path: 'seo', title: 'SEO — Admin Raijin', loadComponent: () => import('./pages/seo/seo.page').then((m) => m.AdminSeoPage) },
      { path: 'acquisition', title: 'Acquisition — Admin Raijin', loadComponent: () => import('./pages/acquisition/acquisition.page').then((m) => m.AdminAcquisitionPage) },
      { path: 'revenus', title: 'Revenus — Admin Raijin', loadComponent: () => import('./pages/revenue/revenue.page').then((m) => m.AdminRevenuePage) },
      { path: 'essais', title: 'Essais — Admin Raijin', loadComponent: () => import('./pages/trials/trials.page').then((m) => m.AdminTrialsPage) },
      { path: 'utilisateurs', title: 'Utilisateurs — Admin Raijin', loadComponent: () => import('./pages/users/users.page').then((m) => m.AdminUsersPage) },
      { path: 'produit', title: 'Produit — Admin Raijin', loadComponent: () => import('./pages/product/product.page').then((m) => m.AdminProductPage) },
      { path: 'sante', title: 'Santé — Admin Raijin', loadComponent: () => import('./pages/health/health.page').then((m) => m.AdminHealthPage) },
      {
        path: 'double-authentification',
        title: 'Double authentification — Admin Raijin',
        loadComponent: () => import('./security/account-security.page').then((m) => m.AdminAccountSecurityPage),
      },
      ...devOnlyChildren,
    ],
  },
];
