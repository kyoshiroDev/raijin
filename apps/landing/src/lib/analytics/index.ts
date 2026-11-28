/** API publique de la mesure d'audience de la landing (docs/ANALYTICS.md). */
export { track, trackFromElement } from './track';
export { hasAnalyticsConsent, readConsent } from './consent';
export { decorateAppUrl, readStoredAttribution } from './attribution';
