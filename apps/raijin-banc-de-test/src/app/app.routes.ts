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
    path: 'forgot-password',
    canActivate: [guestGuard],
    title: 'Mot de passe oublié · Raijin-banc-de-test',
    loadComponent: () => import('./features/auth/forgot-password-page').then((m) => m.ForgotPasswordPage),
  },
  {
    // No guard on purpose: the recovery session makes the user "authenticated",
    // so guestGuard would bounce them away before they can set a new password.
    // The page itself only shows the form after a PASSWORD_RECOVERY event (AuthStore).
    path: 'auth/reset',
    title: 'Nouveau mot de passe · Raijin-banc-de-test',
    loadComponent: () => import('./features/auth/reset-password-page').then((m) => m.ResetPasswordPage),
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
        // Justesse des verdicts du moteur (phase 7 bis, docs/ARCHITECTURE.md §16.6) : données simulées jusqu'à la phase 8 bis.
        path: 'justesse',
        title: 'Justesse des verdicts · Raijin-banc-de-test',
        loadComponent: () => import('./features/verdict-quality/verdict-quality-page').then((m) => m.VerdictQualityPage),
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
