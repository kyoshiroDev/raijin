import {
  ALERT_TYPES,
  ALERT_TYPE_LABELS,
  ANALYSIS_ERROR_MESSAGES,
  DEFAULT_NOTIFICATION_PREFERENCES,
  PAGE_LIMIT_DEFAULT,
  WATCH_ERROR_CODES,
  WATCH_ERROR_MESSAGES,
  alertListQuerySchema,
  alertListResponseSchema,
  alertReadRequestSchema,
  alertSchema,
  apiErrorCodeSchema,
  notificationPreferencesUpdateSchema,
  pushNotificationPayloadSchema,
  pushSubscriptionRequestSchema,
  vapidPublicKeyResponseSchema,
  watchCreateRequestSchema,
  watchEventSchema,
  watchListResponseSchema,
  watchSnapshotSchema,
  watchUpdateRequestSchema,
  type Alert,
  type WatchSnapshot,
} from '../../index';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OWNER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ID = '01968b3a-7c2e-7d4a-9f00-0123456789ab';
const NOW = '2026-11-22T10:00:00.000Z';
const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);

function buildAlert(): Alert {
  return {
    id: ID,
    mint: MINT,
    token: null,
    severity: 'danger',
    createdAt: NOW,
    readAt: null,
    type: 'lp_removed',
    payload: {
      poolAddress: OWNER,
      dex: 'raydium',
      dropPct: 42.5,
      liquidityUsdBefore: 120_000,
      liquidityUsdAfter: 60_000,
      referenceAt: NOW,
    },
  };
}

describe('suivis', () => {
  it('création : mint seul, champs inconnus refusés', () => {
    expect(watchCreateRequestSchema.safeParse({ mint: MINT }).success).toBe(true);
    expect(watchCreateRequestSchema.safeParse({ mint: MINT, userId: ID }).success).toBe(false);
    expect(watchCreateRequestSchema.safeParse({ mint: 'pas-une-adresse' }).success).toBe(false);
  });

  it('mise en pause / reprise', () => {
    expect(watchUpdateRequestSchema.parse({ status: 'paused' })).toEqual({ status: 'paused' });
    expect(watchUpdateRequestSchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });

  it('liste avec dernier verdict et limites du plan', () => {
    const parsed = watchListResponseSchema.parse({
      items: [
        {
          id: ID,
          mint: MINT,
          token: null,
          status: 'paused',
          pausedReason: 'plan_limit',
          lastVerdict: 'warn',
          lastCheckedAt: NOW,
          unreadAlerts: 2,
          createdAt: NOW,
        },
      ],
      limits: { plan: 'FREE', trialActive: false, maxActiveWatches: 3, pushAlerts: false, alertHistoryDays: 30 },
      activeCount: 0,
      pausedCount: 1,
    });
    expect(parsed.items[0]?.lastVerdict).toBe('warn');
  });
});

describe('alertes', () => {
  it('union discriminée sur le type', () => {
    expect(alertSchema.parse(buildAlert()).type).toBe('lp_removed');
    const wrongPayload = { ...buildAlert(), type: 'holder_sold' };
    expect(alertSchema.safeParse(wrongPayload).success).toBe(false);
  });

  it('verdict_degraded exige une vraie dégradation', () => {
    const base = { ...buildAlert(), type: 'verdict_degraded' as const };
    const payload = { reasonCodes: ['MINT_AUTHORITY_ACTIVE'], analysisId: ID };
    expect(alertSchema.safeParse({ ...base, payload: { ...payload, from: 'safe', to: 'danger' } }).success).toBe(true);
    expect(alertSchema.safeParse({ ...base, payload: { ...payload, from: 'danger', to: 'warn' } }).success).toBe(false);
  });

  it('libellé pour chaque type', () => {
    for (const type of ALERT_TYPES) expect(ALERT_TYPE_LABELS[type].length).toBeGreaterThan(0);
  });

  it('filtres : types séparés par des virgules, pagination par défaut', () => {
    const query = alertListQuerySchema.parse({ status: 'unread', types: 'lp_removed,holder_sold', limit: '10' });
    expect(query).toEqual({ status: 'unread', types: ['lp_removed', 'holder_sold'], limit: 10 });
    expect(alertListQuerySchema.parse({})).toEqual({ status: 'all', limit: PAGE_LIMIT_DEFAULT });
    expect(alertListQuerySchema.safeParse({ types: 'moon' }).success).toBe(false);
    expect(alertListQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
    expect(alertListQuerySchema.safeParse({ cursor: 'a/b' }).success).toBe(false);
  });

  it('réponse paginée avec non lues', () => {
    const page = alertListResponseSchema.parse({ items: [buildAlert()], nextCursor: null, unread: 1 });
    expect(page.unread).toBe(1);
  });

  it('lu / non lu par lot ou tout lu', () => {
    expect(alertReadRequestSchema.safeParse({ ids: [ID], read: false }).success).toBe(true);
    expect(alertReadRequestSchema.safeParse({ all: true, read: true }).success).toBe(true);
    expect(alertReadRequestSchema.safeParse({ all: true, read: false }).success).toBe(false);
    expect(alertReadRequestSchema.safeParse({ ids: [], read: true }).success).toBe(false);
  });
});

describe('événements et instantanés (serveur, banc)', () => {
  it('événement détecté : gravité et clé d’idempotence', () => {
    const event = {
      type: 'holder_sold',
      payload: { owner: OWNER, beforePct: 8, afterPct: null, soldPctOfPosition: 100 },
      severity: 'warn',
      dedupeKey: `holder_sold:${OWNER}:2026-11-22T09:30:00.000Z`,
      detectedAt: NOW,
    };
    expect(watchEventSchema.safeParse(event).success).toBe(true);
    expect(watchEventSchema.safeParse({ ...event, dedupeKey: 'holder sold' }).success).toBe(false);
  });

  it('instantané par groupes, chacun daté', () => {
    const snapshot: WatchSnapshot = {
      version: 1,
      mint: MINT,
      authorities: { mintAuthorityActive: false, freezeAuthorityActive: false, observedAt: NOW },
      pool: {
        address: OWNER,
        dex: 'raydium',
        base: 1_000_000,
        quote: 500,
        sqrtK: Math.sqrt(1_000_000 * 500),
        liquidityUsd: 100_000,
        peakSqrtK: Math.sqrt(1_000_000 * 500),
        peakAt: NOW,
        observedAt: NOW,
      },
      holders: { supply: '1000000000', top: [{ owner: OWNER, tokenAccount: MINT, amount: '80000000', pct: 8 }], observedAt: NOW },
      verdict: null,
    };
    expect(watchSnapshotSchema.parse(snapshot).holders?.top).toHaveLength(1);
    expect(watchSnapshotSchema.safeParse({ ...snapshot, holders: { ...snapshot.holders, supply: '1e9' } }).success).toBe(false);
  });
});

describe('notifications et push', () => {
  it('préférences : mise à jour partielle non vide', () => {
    expect(notificationPreferencesUpdateSchema.safeParse({ weeklyDigest: true }).success).toBe(true);
    expect(notificationPreferencesUpdateSchema.safeParse({}).success).toBe(false);
    expect(notificationPreferencesUpdateSchema.safeParse({ sms: true }).success).toBe(false);
    expect(DEFAULT_NOTIFICATION_PREFERENCES.emailAlerts).toBe(true);
  });

  it('abonnement : endpoint https d’un service push connu uniquement (pas de SSRF)', () => {
    const keys = { p256dh: P256DH, auth: AUTH };
    const ok = (endpoint: string) => pushSubscriptionRequestSchema.safeParse({ endpoint, keys }).success;
    expect(ok('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(ok('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(ok('https://web.push.apple.com/QAbc')).toBe(true);
    expect(ok('https://wns2-par02p.notify.windows.com/w/?token=abc')).toBe(true);
    expect(ok('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(ok('https://evil.example/fcm.googleapis.com')).toBe(false);
    expect(ok('https://169.254.169.254/latest')).toBe(false);
    expect(pushSubscriptionRequestSchema.safeParse({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'x', auth: AUTH } }).success).toBe(false);
  });

  it('clé publique VAPID', () => {
    expect(vapidPublicKeyResponseSchema.safeParse({ publicKey: P256DH }).success).toBe(true);
    expect(vapidPublicKeyResponseSchema.safeParse({ publicKey: 'court' }).success).toBe(false);
  });

  it('charge utile au format du service worker Angular', () => {
    const payload = {
      notification: {
        title: 'Raijin : alerte Danger',
        body: 'Liquidité retirée de 42 %.',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag: `alert:${MINT}`,
        renotify: true,
        lang: 'fr',
        timestamp: 1_764_000_000_000,
        data: {
          alertId: ID,
          mint: MINT,
          onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: `/alertes?alerte=${ID}` } },
        },
      },
    };
    expect(pushNotificationPayloadSchema.safeParse(payload).success).toBe(true);
    const external = {
      notification: {
        ...payload.notification,
        data: { ...payload.notification.data, onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: 'https://evil.example' } } },
      },
    };
    expect(pushNotificationPayloadSchema.safeParse(external).success).toBe(false);
  });
});

describe('codes d’erreur de la phase 4', () => {
  it('ajoutés au format d’erreur standard, avec un message', () => {
    for (const code of WATCH_ERROR_CODES) {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
      expect(WATCH_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
    expect(apiErrorCodeSchema.safeParse('MAINTENANCE').success).toBe(true);
    expect(apiErrorCodeSchema.safeParse('TOKEN_UNANALYZABLE').success).toBe(true);
    expect(ANALYSIS_ERROR_MESSAGES.TOKEN_UNANALYZABLE).toMatch(/analyser/);
  });
});
