import { Route } from '@angular/router';
import { WebFeatureAlertes } from './web-feature-alertes/web-feature-alertes';
import { WebFeatureSuivis } from './web-feature-suivis/web-feature-suivis';

export const webFeatureSuivisRoutes: Route[] = [
  { path: '', component: WebFeatureSuivis },
];

/** Écran « Alertes », routé sur /alertes par apps/web. */
export const webFeatureAlertesRoutes: Route[] = [
  { path: '', component: WebFeatureAlertes },
];
