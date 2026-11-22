import type { Alert, AlertListResponse, NotificationSettings, PlanLimits, Watch, WatchListResponse } from '@raijin/shared-contracts';

/** Données de test conformes aux contrats des suivis, alertes et notifications (specs des features). */
export const FIXTURE_MINTS = {
  bonk: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  jup: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
} as const;

const NOW = '2026-11-22T10:00:00.000Z';

export function fakeWatchId(n: number): string {
  return `01968b3a-7c2e-7d4a-9f00-${String(n).padStart(12, '0')}`;
}

export function fakeAlertId(n: number): string {
  return `01968b3a-7c2e-7d4a-af00-${String(n).padStart(12, '0')}`;
}

export function fakeLimits(overrides: Partial<PlanLimits> = {}): PlanLimits {
  return { plan: 'FREE', trialActive: false, maxActiveWatches: 3, pushAlerts: false, alertHistoryDays: 30, ...overrides };
}

export function fakeWatch(overrides: Partial<Watch> = {}): Watch {
  const mint = overrides.mint ?? FIXTURE_MINTS.bonk;
  return {
    id: fakeWatchId(1),
    mint,
    token: { mint, name: 'Bonk', symbol: 'BONK', decimals: 5, tokenProgram: 'spl-token', untrusted: true },
    status: 'active',
    pausedReason: null,
    lastVerdict: 'safe',
    lastCheckedAt: NOW,
    unreadAlerts: 0,
    createdAt: NOW,
    ...overrides,
  };
}

export function fakeWatchList(items: Watch[] = [fakeWatch()], limits: Partial<PlanLimits> = {}): WatchListResponse {
  return {
    items,
    limits: fakeLimits(limits),
    activeCount: items.filter((watch) => watch.status === 'active').length,
    pausedCount: items.filter((watch) => watch.status === 'paused').length,
  };
}

const ALERT_BASE = {
  mint: FIXTURE_MINTS.bonk,
  token: { mint: FIXTURE_MINTS.bonk, name: 'Bonk', symbol: 'BONK', decimals: 5, tokenProgram: 'spl-token', untrusted: true },
  createdAt: NOW,
  readAt: null,
} as const;

/** Une alerte de chaque type (charges utiles réalistes). */
export function fakeAlerts(): Alert[] {
  return [
    {
      ...ALERT_BASE,
      id: fakeAlertId(1),
      type: 'lp_removed',
      severity: 'danger',
      payload: {
        poolAddress: FIXTURE_MINTS.usdc,
        dex: 'raydium',
        dropPct: 42.5,
        liquidityUsdBefore: 120_000,
        liquidityUsdAfter: 69_000,
        referenceAt: '2026-11-22T07:00:00.000Z',
      },
    },
    {
      ...ALERT_BASE,
      id: fakeAlertId(2),
      type: 'verdict_degraded',
      severity: 'danger',
      createdAt: '2026-11-22T08:00:00.000Z',
      payload: { from: 'warn', to: 'danger', reasonCodes: ['MINT_AUTHORITY_ACTIVE'], analysisId: null },
    },
    {
      ...ALERT_BASE,
      id: fakeAlertId(3),
      type: 'holder_sold',
      severity: 'warn',
      createdAt: '2026-11-21T18:30:00.000Z',
      readAt: '2026-11-21T19:00:00.000Z',
      payload: { owner: FIXTURE_MINTS.jup, beforePct: 8.2, afterPct: 3.1, soldPctOfPosition: 62.2 },
    },
    {
      ...ALERT_BASE,
      id: fakeAlertId(4),
      type: 'mint_reactivated',
      severity: 'danger',
      createdAt: '2026-11-20T12:00:00.000Z',
      payload: { revokedObservedAt: '2026-11-20T11:55:00.000Z' },
    },
    {
      ...ALERT_BASE,
      id: fakeAlertId(5),
      type: 'freeze_reactivated',
      severity: 'danger',
      createdAt: '2026-11-19T09:00:00.000Z',
      readAt: '2026-11-19T10:00:00.000Z',
      payload: { revokedObservedAt: '2026-11-19T08:55:00.000Z' },
    },
  ];
}

export function fakeAlertPage(items: Alert[] = fakeAlerts(), nextCursor: string | null = null, unread?: number): AlertListResponse {
  return { items, nextCursor, unread: unread ?? items.filter((alert) => alert.readAt === null).length };
}

export function fakeNotificationSettings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    preferences: { emailAlerts: true, pushAlerts: true, weeklyDigest: false },
    pushAllowed: false,
    pushConfigured: true,
    pushDevices: 0,
    emailVerified: true,
    ...overrides,
  };
}
