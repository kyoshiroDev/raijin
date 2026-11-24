import {
  ADMIN_ERROR_CODES,
  ADMIN_ERROR_MESSAGES,
  ADMIN_KPI_KEYS,
  ATTRIBUTION_QUERY_PARAMS,
  DAILY_METRICS,
  FUNNEL_STEPS,
  adminAcquisitionQuerySchema,
  adminAuditLogQuerySchema,
  adminEnrollmentStartSchema,
  adminHealthSchema,
  adminOverviewSchema,
  adminRangeQuerySchema,
  adminSecondFactorSchema,
  adminSeoSchema,
  adminTrafficSchema,
  adminUserActionRequestSchema,
  adminUserDetailSchema,
  adminUserListQuerySchema,
  apiErrorCodeSchema,
  funnelStepRate,
  stripeDashboardCustomerUrl,
  auditLogEntrySchema,
  billingAccountSchema,
  computeChange,
  daysInRange,
  googleServiceStateSchema,
  isDailyMetricKey,
  planSourceSchema,
  quotaLevel,
  signupAttributionSchema,
  totpCodeSchema,
  recoveryCodeSchema,
} from '../../index';

const UUID = '01933b7e-8f00-7000-8000-000000000001';
const RANGE = {
  period: '7d' as const,
  current: { from: '2026-11-16', to: '2026-11-22' },
  previous: { from: '2026-11-09', to: '2026-11-15' },
  timezone: 'UTC' as const,
};

describe('admin : erreurs', () => {
  it('ajoute les codes admin au contrat d’erreur, avec un message chacun', () => {
    for (const code of ADMIN_ERROR_CODES) {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(ADMIN_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
    }
  });
});

describe('admin : 2FA', () => {
  it('normalise les codes TOTP et de secours', () => {
    expect(totpCodeSchema.parse('123 456')).toBe('123456');
    expect(totpCodeSchema.safeParse('12345').success).toBe(false);
    expect(totpCodeSchema.safeParse('12345a').success).toBe(false);
    expect(recoveryCodeSchema.parse(' abcde-fgh23 ')).toBe('ABCDE-FGH23');
    expect(recoveryCodeSchema.safeParse('ABCDE-FGH21').success).toBe(false);
  });

  it('distingue code TOTP et code de secours, sans champ en trop', () => {
    expect(adminSecondFactorSchema.parse({ method: 'totp', code: '000111' })).toEqual({ method: 'totp', code: '000111' });
    expect(adminSecondFactorSchema.safeParse({ method: 'recovery', code: '000111' }).success).toBe(false);
    expect(adminSecondFactorSchema.safeParse({ method: 'totp', code: '000111', userId: UUID }).success).toBe(false);
  });

  it('borne le début d’enrôlement (QR en data URI SVG, secret base32 de 160 bits)', () => {
    const start = {
      otpauthUri: 'otpauth://totp/Raijin%20Shield:admin?secret=X&issuer=Raijin%20Shield',
      secret: 'A'.repeat(32),
      qrCodeDataUri: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      expiresAt: '2026-11-22T10:10:00.000Z',
    };
    expect(adminEnrollmentStartSchema.safeParse(start).success).toBe(true);
    expect(adminEnrollmentStartSchema.safeParse({ ...start, qrCodeDataUri: 'javascript:alert(1)' }).success).toBe(false);
  });
});

describe('admin : périodes et KPI', () => {
  it('valide les périodes personnalisées', () => {
    expect(adminRangeQuerySchema.parse({})).toEqual({ period: '7d' });
    expect(adminRangeQuerySchema.safeParse({ from: '2026-11-01' }).success).toBe(false);
    expect(adminRangeQuerySchema.safeParse({ from: '2026-11-10', to: '2026-11-01' }).success).toBe(false);
    expect(adminRangeQuerySchema.safeParse({ from: '2025-01-01', to: '2026-11-01' }).success).toBe(false);
    expect(adminAcquisitionQuerySchema.parse({ period: '30d' })).toEqual({ period: '30d', dimension: 'source' });
    expect(daysInRange('2026-11-16', '2026-11-22')).toBe(7);
  });

  it('calcule la variation sans diviser par zéro', () => {
    expect(computeChange(120, 100)).toBeCloseTo(0.2);
    expect(computeChange(80, 100)).toBeCloseTo(-0.2);
    expect(computeChange(5, 0)).toBeNull();
    expect(computeChange(null, 3)).toBeNull();
  });

  it('accepte une vue d’ensemble complète avec GA4 non connecté', () => {
    const overview = {
      generatedAt: '2026-11-22T10:00:00.000Z',
      range: RANGE,
      kpis: ADMIN_KPI_KEYS.map((key) => ({
        key,
        unit: key === 'mrr_cents' ? 'cents' : key === 'churn_rate' ? 'ratio' : 'count',
        value: key === 'landing_visitors' ? null : 3,
        previous: key === 'landing_visitors' ? null : 2,
        change: key === 'landing_visitors' ? null : 0.5,
        higherIsBetter: key !== 'churn_rate',
        source: key === 'landing_visitors' ? 'ga4' : 'internal',
        status: key === 'landing_visitors' ? 'not_connected' : 'ok',
      })),
      trend: [{ key: 'signups', unit: 'count', points: [{ date: '2026-11-22', value: 3 }] }],
      funnel: FUNNEL_STEPS.map((key, index) => ({
        key,
        value: index === 0 ? null : 10 - index,
        rateFromPrevious: index < 2 ? null : 0.8,
        source: index === 0 ? 'ga4' : 'internal',
        status: index === 0 ? 'not_connected' : 'ok',
      })),
      ga4: { status: 'not_connected' },
      aggregatedThrough: null,
    };
    expect(adminOverviewSchema.safeParse(overview).success).toBe(true);
    expect(adminOverviewSchema.safeParse({ ...overview, kpis: overview.kpis.slice(1) }).success).toBe(false);
  });
});

describe('admin : services Google', () => {
  it('n’accepte des données que si le service est connecté', () => {
    expect(adminSeoSchema.safeParse({ service: { status: 'not_connected' }, data: null }).success).toBe(true);
    expect(adminSeoSchema.safeParse({ service: { status: 'error', error: 'permission_denied' }, data: null }).success).toBe(true);
    expect(adminTrafficSchema.safeParse({ range: RANGE, service: { status: 'not_connected' }, data: {} }).success).toBe(false);
    expect(googleServiceStateSchema.safeParse({ status: 'error', error: 'raw google message' }).success).toBe(false);
  });

  it('refuse les caractères de contrôle dans les textes venus de Google', () => {
    const connected = {
      status: 'connected',
      fetchedAt: '2026-11-22T10:00:00.000Z',
      cachedUntil: '2026-11-22T11:00:00.000Z',
      simulated: true,
    };
    const row = { key: 'rug pull solana', clicks: 3, impressions: 120, ctr: 0.025, position: 7.4 };
    const data = {
      window: '28d',
      startDate: '2026-10-23',
      dataThrough: '2026-11-19',
      lagDays: 3,
      totals: { clicks: 3, impressions: 120, ctr: 0.025, position: 7.4 },
      previousTotals: null,
      series: [],
      topQueries: [row],
      topPages: [],
      opportunities: [row],
    };
    expect(adminSeoSchema.safeParse({ service: connected, data }).success).toBe(true);
    const hostile = { ...data, topQueries: [{ ...row, key: 'a\u0000b' }] };
    expect(adminSeoSchema.safeParse({ service: connected, data: hostile }).success).toBe(false);
  });
});

describe('admin : agrégats et santé', () => {
  it('connaît le catalogue DailyMetric, familles par source comprises', () => {
    expect(isDailyMetricKey('signups')).toBe(true);
    expect(isDailyMetricKey('checks_unavailable.rugcheck')).toBe(true);
    expect(isDailyMetricKey('checks_unavailable.inconnu')).toBe(false);
    expect(isDailyMetricKey('user_email')).toBe(false);
    expect(DAILY_METRICS.mrr_cents.aggregation).toBe('last');
  });

  it('classe les quotas (80 % = avertissement)', () => {
    expect(quotaLevel(null)).toBe('ok');
    expect(quotaLevel(0.79)).toBe('ok');
    expect(quotaLevel(0.8)).toBe('warning');
    expect(quotaLevel(1.2)).toBe('critical');
  });

  it('accepte un état de santé minimal', () => {
    const health = {
      generatedAt: '2026-11-22T10:00:00.000Z',
      jobs: [
        {
          name: 'metrics-aggregate',
          lastRunAt: null,
          lastStatus: null,
          lastDurationMs: null,
          consecutiveFailures: 0,
          lastErrorCode: null,
          nextRunAt: null,
        },
      ],
      quotas: [{ service: 'helius', period: 'day', used: 18000, limit: 22000, ratio: 18000 / 22000, level: 'warning' }],
      api: { window: '24h', requests: 0, serverErrors: 0, errorRate: null },
      emails: { provider: 'smtp', sent24h: 0, failed24h: 0 },
      push: { provider: 'unavailable', activeSubscriptions: 0 },
      database: { sizeBytes: null },
      services: { helius: 'configured', ga4: 'not_configured' },
      alerts: [],
    };
    expect(adminHealthSchema.safeParse(health).success).toBe(true);
  });
});

describe('admin : utilisateurs et actions', () => {
  it('borne la recherche par e-mail', () => {
    expect(adminUserListQuerySchema.parse({ q: ' Ab@ ' })).toMatchObject({ q: 'ab@', limit: 20 });
    expect(adminUserListQuerySchema.safeParse({ q: 'ab' }).success).toBe(false);
    expect(adminUserListQuerySchema.safeParse({ signupFrom: '2026-11-10', signupTo: '2026-11-01' }).success).toBe(false);
  });

  it('exige motif et confirmations selon l’action, sans champ en trop', () => {
    expect(adminUserActionRequestSchema.safeParse({ type: 'extend_trial', days: 3, reason: 'Bug signalé' }).success).toBe(true);
    expect(adminUserActionRequestSchema.safeParse({ type: 'extend_trial', days: 30, reason: 'Bug signalé' }).success).toBe(false);
    expect(adminUserActionRequestSchema.safeParse({ type: 'grant_pro_month', reason: '  ' }).success).toBe(false);
    expect(adminUserActionRequestSchema.safeParse({ type: 'suspend', reason: 'Abus' }).success).toBe(false);
    expect(
      adminUserActionRequestSchema.safeParse({ type: 'delete', reason: 'Demande RGPD', confirmEmail: 'a@b.fr' }).success,
    ).toBe(false);
    expect(
      adminUserActionRequestSchema.safeParse({
        type: 'delete',
        reason: 'Demande RGPD',
        confirmEmail: 'A@B.fr',
        totpCode: '123456',
      }).success,
    ).toBe(true);
    expect(adminUserActionRequestSchema.safeParse({ type: 'resend_verification', userId: UUID }).success).toBe(false);
    // Pas d'usurpation : aucune action de connexion en tant que l'utilisateur.
    expect(adminUserActionRequestSchema.safeParse({ type: 'impersonate' }).success).toBe(false);
  });

  it('valide une fiche, lien Stripe sur l’hôte exact seulement', () => {
    const detail = {
      id: UUID,
      email: 'a@b.fr',
      plan: 'PRO',
      planSource: 'gift',
      role: 'USER',
      status: 'active',
      trialStatus: 'ended',
      createdAt: '2026-11-01T10:00:00.000Z',
      lastLoginAt: null,
      utmSource: 'x\u0007',
      emailVerified: true,
      trial: {
        status: 'ended',
        startedAt: '2026-11-01T10:00:00.000Z',
        endsAt: '2026-11-08T10:00:00.000Z',
        daysRemaining: null,
        endScreenDue: false,
        notice: null,
      },
      subscription: null,
      stripeDashboardUrl: 'https://dashboard.stripe.com/test/customers/cus_ABC123',
      giftEndsAt: '2026-12-22T10:00:00.000Z',
      suspendedAt: null,
      attribution: { utmSource: null, utmMedium: null, utmCampaign: null, referrer: null, landingPath: '/' },
      usage: { analysesToday: 0, analyses30d: 4, walletScans30d: 0, alerts30d: 1 },
      watches: { active: 1, paused: 0 },
      pushSubscriptions: 0,
      audit: [],
      availableActions: ['grant_pro_month', 'suspend', 'delete'],
    };
    expect(adminUserDetailSchema.safeParse(detail).success).toBe(false);
    const clean = { ...detail, utmSource: 'newsletter' };
    expect(adminUserDetailSchema.safeParse(clean).success).toBe(true);
    expect(
      adminUserDetailSchema.safeParse({ ...clean, stripeDashboardUrl: 'https://dashboard.stripe.com.evil.io/customers/cus_A' })
        .success,
    ).toBe(false);
  });

  it('journal d’audit : actions libres mais bornées, filtres paginés', () => {
    const entry = {
      id: UUID,
      action: 'admin.trial_extended',
      actorKind: 'admin',
      actor: { id: UUID, email: 'admin@raijin.local' },
      targetUserId: UUID,
      metadata: {
        before: { trialEndsAt: '2026-11-22T10:00:00.000Z' },
        after: { trialEndsAt: '2026-11-25T10:00:00.000Z' },
        reason: 'Bug',
        details: { days: 3 },
      },
      createdAt: '2026-11-22T10:00:00.000Z',
    };
    expect(auditLogEntrySchema.safeParse(entry).success).toBe(true);
    expect(auditLogEntrySchema.safeParse({ ...entry, action: 'DROP TABLE' }).success).toBe(false);
    expect(adminAuditLogQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 });
  });
});

describe('admin : impacts sur les contrats existants', () => {
  it('ajoute la source « gift » et giftEndsAt facultatif (fixtures existantes inchangées)', () => {
    expect(planSourceSchema.safeParse('gift').success).toBe(true);
    expect(billingAccountSchema.shape.giftEndsAt.safeParse(undefined).success).toBe(true);
  });

  it('paramètres d’attribution alignés sur le contrat d’inscription', () => {
    expect(Object.keys(ATTRIBUTION_QUERY_PARAMS).sort()).toEqual(Object.keys(signupAttributionSchema.shape).sort());
  });
});

describe('Justesse des métriques admin (phase 9)', () => {
  it('funnelStepRate : jamais au-delà de 100 %, dépassement signalé, null sans base', () => {
    expect(funnelStepRate(25, 100)).toEqual({ rateFromPrevious: 0.25, exceedsPrevious: false });
    expect(funnelStepRate(100, 100)).toEqual({ rateFromPrevious: 1, exceedsPrevious: false });
    expect(funnelStepRate(300, 120)).toEqual({ rateFromPrevious: 1, exceedsPrevious: true });
    expect(funnelStepRate(5, 0)).toEqual({ rateFromPrevious: null, exceedsPrevious: false });
    expect(funnelStepRate(null, 10)).toEqual({ rateFromPrevious: null, exceedsPrevious: false });
  });

  it('stripeDashboardCustomerUrl : réel ou /test/ selon le mode, identifiant vérifié', () => {
    expect(stripeDashboardCustomerUrl('cus_A1', true)).toBe('https://dashboard.stripe.com/customers/cus_A1');
    expect(stripeDashboardCustomerUrl('cus_A1', false)).toBe('https://dashboard.stripe.com/test/customers/cus_A1');
    expect(stripeDashboardCustomerUrl('cus_A1/../x', true)).toBeNull();
    expect(stripeDashboardCustomerUrl(null, true)).toBeNull();
  });

  it('analyses : échec complet et résultat partiel sont deux métriques distinctes ; api.estimated vaut true par défaut', () => {
    expect(DAILY_METRICS.analyses_failed).toEqual({ unit: 'count', aggregation: 'sum' });
    expect(DAILY_METRICS.analyses_partial).toEqual({ unit: 'count', aggregation: 'sum' });
    expect(adminHealthSchema.shape.api.parse({ window: '24h', requests: 1, serverErrors: 0, errorRate: 0 }).estimated).toBe(true);
  });
});
