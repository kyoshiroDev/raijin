import type { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth/auth-guard';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Connexion · Raijin-banc-de-test',
    loadComponent: () => import('./features/auth/login-page').then((m) => m.LoginPage),
  },
  {
    // Signed-in area: every child renders inside the shell (sticky headers + bottom tab bar).
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./core/layout/app-shell').then((m) => m.AppShell),
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'Opportunités · Raijin-banc-de-test',
        loadComponent: () => import('./features/opportunities/opportunities-page').then((m) => m.OpportunitiesPage),
      },
      {
        path: 'token/:mint',
        title: 'Token · Raijin-banc-de-test',
        loadComponent: () => import('./features/opportunities/token-page').then((m) => m.TokenPage),
      },
      {
        path: 'alerts',
        title: 'Alertes · Raijin-banc-de-test',
        loadComponent: () => import('./features/alerts/alerts-page').then((m) => m.AlertsPage),
      },
      {
        path: 'portfolio',
        title: 'Portefeuille · Raijin-banc-de-test',
        loadComponent: () => import('./features/portfolio/portfolio-page').then((m) => m.PortfolioPage),
      },
      {
        path: 'performance',
        title: 'Performance · Raijin-banc-de-test',
        loadComponent: () => import('./features/performance/performance-page').then((m) => m.PerformancePage),
      },
      {
        // « Laboratoire » view of the Performance screen (segmented control « Signaux | Laboratoire »), deep-linkable.
        path: 'performance/lab',
        title: 'Laboratoire · Raijin-banc-de-test',
        loadComponent: () => import('./features/strategy-lab/strategy-lab-page').then((m) => m.StrategyLabPage),
      },
      {
        // Justesse des verdicts du moteur (phase 7 bis, docs/ARCHITECTURE.md §16.6) : rapport calculé par l'API du banc (GET /api/verdicts/quality).
        path: 'justesse',
        title: 'Justesse des verdicts · Raijin-banc-de-test',
        loadComponent: () => import('./features/verdict-quality/verdict-quality-page').then((m) => m.VerdictQualityPage),
      },
      {
        // Mode ombre (docs/ARCHITECTURE.md §17.6) : collecte du VPS comparée à l'instantané `shadow_ref`.
        path: 'comparaison',
        title: 'Comparaison mode ombre · Raijin-banc-de-test',
        loadComponent: () => import('./features/shadow/shadow-comparison-page').then((m) => m.ShadowComparisonPage),
      },
      {
        path: 'settings',
        title: 'Réglages · Raijin-banc-de-test',
        loadComponent: () => import('./features/settings/settings-page').then((m) => m.SettingsPage),
      },
      {
        path: 'account',
        title: 'Mon compte · Raijin-banc-de-test',
        loadComponent: () => import('./features/account/account-page').then((m) => m.AccountPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
