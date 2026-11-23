import { Route } from '@angular/router';
import { AnalysisStore } from '@raijin/web-data-access';
import { AnalysePage } from './pages/analyse.page';
import { mintQueryRedirect } from './pages/mint-query';
import { PublicTokenPage } from './pages/public-token.page';

/**
 * Écran d'analyse (`/analyse`, `/analyse/:mint`). Le store est fourni au niveau de la route
 * parente : il survit au passage de `/analyse` à `/analyse/<mint>` après une analyse.
 * Composants référencés directement : la feature est déjà chargée à la demande, un second
 * découpage ajouterait une requête en cascade avant l'affichage (LCP).
 */
export const webFeatureAnalyseRoutes: Route[] = [
  {
    path: '',
    providers: [AnalysisStore],
    children: [
      // `?mint=` : repli sans JS du champ de la landing (redirection vers `/analyse/<mint>`).
      { path: '', component: AnalysePage, canActivate: [mintQueryRedirect] },
      { path: ':mint', component: AnalysePage, title: 'Analyse — Raijin' },
    ],
  },
];

/** Page publique `/t/:mint` (sans compte), avec son propre store. */
export const webFeaturePublicTokenRoutes: Route[] = [
  { path: ':mint', providers: [AnalysisStore], component: PublicTokenPage, title: 'Verdict — Raijin Shield' },
  { path: '', pathMatch: 'full', redirectTo: '/analyse' },
];
