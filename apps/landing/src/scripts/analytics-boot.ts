// Script module externe (aucun script inline : compatible avec une CSP `script-src 'self'`).
import { bootAnalytics } from '../lib/analytics/boot';
import { bindPageEvents } from '../lib/analytics/page-events';

bootAnalytics(document);
bindPageEvents(document);
