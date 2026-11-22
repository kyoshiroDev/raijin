import { inject } from '@angular/core';
import { Router, type CanMatchFn, type Route } from '@angular/router';
import { AUTH_EMAIL_LINK_PATHS } from '@raijin/shared-contracts';
import { guestGuard } from '@raijin/web-data-access';

/** Chemin relatif à `/compte` d'un lien envoyé par e-mail (contrat partagé avec l'API). */
export function emailLinkPath(key: keyof typeof AUTH_EMAIL_LINK_PATHS): string {
  return AUTH_EMAIL_LINK_PATHS[key].replace(/^\/compte\//, '');
}

/** Le lien magique de l'e-mail et la page de demande partagent le chemin : le jeton les distingue. */
const hasToken: CanMatchFn = () =>
  inject(Router).currentNavigation()?.extractedUrl.queryParamMap.has('token') ?? false;

/**
 * Routes de la feature Compte (`/compte/...`). Chaque écran est chargé à la demande.
 * Les liens des e-mails (`AUTH_EMAIL_LINK_PATHS` + `?token=`) arrivent sur `verifier-email`,
 * `lien-magique` (avec jeton) et `reinitialiser-mot-de-passe`.
 */
export const webFeatureCompteRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Compte — Raijin',
    // Pas d'authGuard ici : l'écran affiche son skeleton pendant la récupération de la session
    // et renvoie lui-même un visiteur vers la connexion (AccountPage).
    loadComponent: () => import('./pages/account.page').then((m) => m.AccountPage),
  },
  {
    path: emailLinkPath('login'),
    title: 'Connexion — Raijin',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'inscription',
    title: 'Créer un compte — Raijin',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/register.page').then((m) => m.RegisterPage),
  },
  {
    path: emailLinkPath('verifyEmail'),
    title: 'Confirmer ton e-mail — Raijin',
    loadComponent: () => import('./pages/verify-email.page').then((m) => m.VerifyEmailPage),
  },
  {
    // Atterrissage du lien reçu par e-mail (avec `?token=`), avant la page de demande.
    path: emailLinkPath('magicLink'),
    title: 'Connexion — Raijin',
    canMatch: [hasToken],
    loadComponent: () => import('./pages/magic-link-verify.page').then((m) => m.MagicLinkVerifyPage),
  },
  {
    path: emailLinkPath('magicLink'),
    title: 'Connexion par e-mail — Raijin',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/magic-link.page').then((m) => m.MagicLinkPage),
  },
  {
    path: emailLinkPath('forgotPassword'),
    title: 'Mot de passe oublié — Raijin',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/forgot-password.page').then((m) => m.ForgotPasswordPage),
  },
  {
    path: emailLinkPath('resetPassword'),
    title: 'Nouveau mot de passe — Raijin',
    loadComponent: () => import('./pages/reset-password.page').then((m) => m.ResetPasswordPage),
  },
];
