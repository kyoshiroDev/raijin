import {
  DAILY_METRICS,
  adminPushNotificationPayloadSchema,
  funnelStepRate,
  funnelStepSchema,
  isDailyMetricKey,
  outgoingPushPayloadSchema,
  pushNotificationPayloadSchema,
  stripeDashboardCustomerUrl,
  type AdminPushNotificationPayload,
} from '../../index';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function adminPayload(): AdminPushNotificationPayload {
  return {
    notification: {
      title: 'Raijin admin : alerte technique',
      body: 'Réanalyse des suivis. Ouvre la santé technique.',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: 'admin-alert',
      renotify: true,
      lang: 'fr',
      timestamp: 1_764_000_000_000,
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: '/admin/sante' } } },
    },
  };
}

function withUrl(url: string): unknown {
  const payload = adminPayload();
  return {
    notification: { ...payload.notification, data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url } } } },
  };
}

describe('charge push admin', () => {
  it('accepte les avis admin et refuse un clic hors de l’espace admin', () => {
    expect(adminPushNotificationPayloadSchema.safeParse(adminPayload()).success).toBe(true);
    expect(adminPushNotificationPayloadSchema.safeParse(withUrl('/admin')).success).toBe(true);
    for (const url of ['/alertes', '/administrateur', 'https://evil.example/admin/', '//evil.example/admin/x']) {
      expect(adminPushNotificationPayloadSchema.safeParse(withUrl(url)).success).toBe(false);
    }
  });

  it('refuse un tag inconnu et toute donnée de token', () => {
    const payload = adminPayload();
    expect(adminPushNotificationPayloadSchema.safeParse({ notification: { ...payload.notification, tag: `alert:${MINT}` } }).success).toBe(false);
    const withMint = { notification: { ...payload.notification, data: { ...payload.notification.data, mint: MINT } } };
    expect(adminPushNotificationPayloadSchema.safeParse(withMint).success).toBe(false);
  });

  it('l’union des charges sortantes accepte l’avis admin, que le contrat de token refuse', () => {
    expect(pushNotificationPayloadSchema.safeParse(adminPayload()).success).toBe(false);
    expect(outgoingPushPayloadSchema.safeParse(adminPayload()).success).toBe(true);
    expect(outgoingPushPayloadSchema.safeParse(withUrl('/compte')).success).toBe(false);
  });
});

describe('champs de justesse des métriques admin', () => {
  it('entonnoir : taux plafonné à 100 % et dépassement signalé', () => {
    expect(funnelStepRate(50, 100)).toEqual({ rateFromPrevious: 0.5, exceedsPrevious: false });
    expect(funnelStepRate(120, 100)).toEqual({ rateFromPrevious: 1, exceedsPrevious: true });
    expect(funnelStepRate(5, 0)).toEqual({ rateFromPrevious: null, exceedsPrevious: false });
    expect(funnelStepRate(null, 10)).toEqual({ rateFromPrevious: null, exceedsPrevious: false });
    const step = funnelStepSchema.parse({ key: 'signups', value: 3, rateFromPrevious: null, source: 'internal', status: 'ok' });
    expect(step.exceedsPrevious).toBe(false);
  });

  it('analyses partielles distinctes des échecs', () => {
    expect(isDailyMetricKey('analyses_partial')).toBe(true);
    expect(DAILY_METRICS.analyses_partial.aggregation).toBe('sum');
    expect(DAILY_METRICS.analyses_failed.aggregation).toBe('sum');
  });

  it('lien Stripe selon le mode de facturation', () => {
    expect(stripeDashboardCustomerUrl('cus_ABC123', false)).toBe('https://dashboard.stripe.com/test/customers/cus_ABC123');
    expect(stripeDashboardCustomerUrl('cus_ABC123', true)).toBe('https://dashboard.stripe.com/customers/cus_ABC123');
    expect(stripeDashboardCustomerUrl(null, true)).toBeNull();
    expect(stripeDashboardCustomerUrl('cus_../x', false)).toBeNull();
  });
});
