import type { AnalysisService } from '@raijin/api-analysis';
import { testConfig } from '@raijin/api-core';
import { createHash } from 'node:crypto';
import { FakePushSender } from '@raijin/api-notifications';
import type { PrismaService } from '@raijin/api-prisma';
import type { AnalysisResult } from '@raijin/shared-contracts';
import { MemoryPrisma } from '../../testing/memory-prisma';
import { AlertsService } from '../alerts/alerts.service';
import { decodeCursor, encodeCursor } from '../alerts/alert-view';
import { NotificationSettingsService } from '../notifications/notification-settings.service';
import { PlanLimitsService, planLimitsOf } from '../plan/plan-limits.service';
import { MAX_PUSH_SUBSCRIPTIONS, PushSubscriptionsService } from '../push/push-subscriptions.service';
import { MintStateService } from '../watch/mint-state.service';
import { WatchesService } from './watches.service';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const U1 = '01968b3a-7c2e-7d4a-9f00-000000000001';
const U2 = '01968b3a-7c2e-7d4a-9f00-000000000002';
const KEY = `B${'A'.repeat(86)}`;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Adresse base58 valide (32 octets) et stable par index. */
function mint(index: number): string {
  let n = BigInt(`0x${createHash('sha256').update(`mint-${index}`).digest('hex')}`) | (1n << 255n);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}
const clock = { now: () => NOW };

function analysis(mintAddress: string): AnalysisResult {
  return {
    mint: mintAddress,
    token: { mint: mintAddress, name: 'Démo', symbol: 'DEMO', decimals: 6, tokenProgram: 'spl-token', untrusted: true },
    verdict: 'warn',
    explanation: 'Explication.',
    checks: [],
    engineVersion: '1.0.0',
    analyzedAt: NOW.toISOString(),
    cached: false,
    degraded: false,
  } as unknown as AnalysisResult;
}

function setup(user: Record<string, unknown> = {}) {
  const prisma = new MemoryPrisma();
  const base = { emailVerifiedAt: NOW, plan: 'FREE', trialStatus: 'NONE', trialEndsAt: null, notifyEmailAlerts: true, notifyPushAlerts: true, notifyWeeklyDigest: false };
  prisma.tables['user']?.push({ id: U1, email: 'a@exemple.fr', ...base, ...user }, { id: U2, email: 'b@exemple.fr', ...base });
  const config = testConfig();
  const plans = new PlanLimitsService(prisma as unknown as PrismaService, clock, config);
  const analyses = { findLatest: jest.fn(async (address: string) => (address === mint(99) ? null : analysis(address))) };
  const mintStates = new MintStateService(prisma as unknown as PrismaService, clock, config);
  const watches = new WatchesService(prisma as unknown as PrismaService, plans, analyses as unknown as AnalysisService, mintStates, clock);
  const push = new FakePushSender(KEY);
  return {
    prisma,
    plans,
    watches,
    alerts: new AlertsService(prisma as unknown as PrismaService, plans, clock),
    settings: new NotificationSettingsService(prisma as unknown as PrismaService, plans, push),
    subscriptions: new PushSubscriptionsService(prisma as unknown as PrismaService, plans, push),
    analyses,
  };
}

describe('limites par plan (relues en base)', () => {
  it('Gratuit 3 / 30 j ; Pro et essai actif 50 / 90 j ; essai expiré = Gratuit', () => {
    const config = testConfig();
    expect(planLimitsOf({ plan: 'FREE', trialStatus: 'NONE', trialEndsAt: null }, NOW, config)).toEqual({
      plan: 'FREE',
      trialActive: false,
      maxActiveWatches: 3,
      pushAlerts: false,
      alertHistoryDays: 30,
    });
    expect(planLimitsOf({ plan: 'PRO', trialStatus: 'NONE', trialEndsAt: null }, NOW, config)).toMatchObject({ maxActiveWatches: 50, pushAlerts: true, alertHistoryDays: 90 });
    const trial = planLimitsOf({ plan: 'FREE', trialStatus: 'ACTIVE', trialEndsAt: new Date(NOW.getTime() + 1) }, NOW, config);
    expect(trial).toMatchObject({ trialActive: true, maxActiveWatches: 50, pushAlerts: true });
    expect(planLimitsOf({ plan: 'FREE', trialStatus: 'ACTIVE', trialEndsAt: new Date(NOW.getTime() - 1) }, NOW, config)).toMatchObject({ maxActiveWatches: 3 });
  });

  it('compte inconnu : 401 ; e-mail non vérifié : 403 AUTH_EMAIL_NOT_VERIFIED', async () => {
    const t = setup({ emailVerifiedAt: null });
    await expect(t.plans.rights('01968b3a-7c2e-7d4a-9f00-0000000000ff')).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
    await expect(t.watches.create(U1, mint(1))).rejects.toMatchObject({ code: 'AUTH_EMAIL_NOT_VERIFIED', status: 403 });
  });
});

describe('WatchesService', () => {
  it('création idempotente, état du mint créé une fois, analyse récente exigée', async () => {
    const t = setup();
    const first = await t.watches.create(U1, mint(1));
    expect(first.created).toBe(true);
    expect(first.watch).toMatchObject({ mint: mint(1), status: 'active', lastVerdict: 'warn', token: expect.objectContaining({ symbol: 'DEMO' }) });
    expect((await t.watches.create(U1, mint(1))).created).toBe(false);
    expect(t.prisma.tables['watch']).toHaveLength(1);
    expect(t.prisma.tables['mintWatchState']).toHaveLength(1);
    await expect(t.watches.create(U1, mint(99))).rejects.toMatchObject({ code: 'ANALYSIS_NOT_FOUND', status: 404 });
  });

  it('limite Gratuit 3 : 4e refusé (403), pause libère une place, reprise refusée au-delà', async () => {
    const t = setup();
    const ids = [];
    for (let index = 0; index < 3; index += 1) ids.push((await t.watches.create(U1, mint(index))).watch.id);
    await expect(t.watches.create(U1, mint(9))).rejects.toMatchObject({ code: 'WATCH_LIMIT_REACHED', status: 403 });
    expect(await t.watches.update(U1, ids[0] as string, 'paused')).toMatchObject({ status: 'paused', pausedReason: 'user' });
    await t.watches.create(U1, mint(9));
    await expect(t.watches.update(U1, ids[0] as string, 'active')).rejects.toMatchObject({ code: 'WATCH_LIMIT_REACHED' });
    expect(await t.watches.update(U1, ids[1] as string, 'active')).toMatchObject({ status: 'active' });
    const list = await t.watches.list(U1);
    expect(list).toMatchObject({ activeCount: 3, pausedCount: 1, limits: { maxActiveWatches: 3 } });
  });

  it('suivi d’un autre utilisateur : 404 ; retrait supprime l’état du mint s’il n’est plus suivi', async () => {
    const t = setup();
    const { watch } = await t.watches.create(U1, mint(1));
    await t.watches.create(U2, mint(1));
    await expect(t.watches.update(U2, watch.id, 'paused')).rejects.toMatchObject({ code: 'WATCH_NOT_FOUND', status: 404 });
    await expect(t.watches.remove(U2, watch.id)).rejects.toMatchObject({ code: 'WATCH_NOT_FOUND' });
    await t.watches.remove(U1, watch.id);
    expect(t.prisma.rawQueries.some((sql) => sql.includes('DELETE FROM "MintWatchState"'))).toBe(true);
  });

  it('enforcePlanLimit : les suivis actifs au-delà de la limite passent en pause (plan_limit), les plus récents d’abord', async () => {
    const t = setup({ plan: 'PRO' });
    for (let index = 0; index < 5; index += 1) {
      await t.watches.create(U1, mint(index));
      const row = t.prisma.tables['watch']?.[index];
      if (row) row['createdAt'] = new Date(NOW.getTime() + index * 1000);
    }
    const user = t.prisma.tables['user']?.[0];
    if (user) user['plan'] = 'FREE';
    expect(await t.watches.enforcePlanLimit(U1)).toBe(2);
    const paused = t.prisma.tables['watch']?.filter((row) => row['status'] === 'paused').map((row) => row['mint']);
    expect(paused).toEqual([mint(3), mint(4)]);
    expect(t.prisma.tables['watch']?.find((row) => row['status'] === 'paused')?.['pausedReason']).toBe('plan_limit');
  });
});

describe('AlertsService', () => {
  function seed(t: ReturnType<typeof setup>, count: number, userId = U1) {
    for (let index = 0; index < count; index += 1) {
      t.prisma.tables['alert']?.push({
        id: `01968b3a-7c2e-7d4a-9f00-${userId.slice(-1)}${String(index).padStart(11, '0')}`,
        userId,
        mint: mint(index % 2),
        type: index % 2 ? 'mint_reactivated' : 'freeze_reactivated',
        severity: 'danger',
        payload: { revokedObservedAt: NOW.toISOString() },
        token: null,
        readAt: null,
        createdAt: new Date(NOW.getTime() - index * 60_000),
      });
    }
  }

  it('pagination par curseur sans doublon ni trou, filtres type et mint, historique du plan', async () => {
    const t = setup();
    seed(t, 25);
    t.prisma.tables['alert']?.push({ ...t.prisma.tables['alert']?.[0], id: '01968b3a-7c2e-7d4a-9f00-0000000000ee', createdAt: new Date(NOW.getTime() - 31 * 86_400_000) });
    const first = await t.alerts.list(U1, { status: 'all', limit: 20 });
    expect(first.items).toHaveLength(20);
    expect(first.unread).toBe(25);
    const second = await t.alerts.list(U1, { status: 'all', limit: 20, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((alert) => alert.id)).size).toBe(25);
    expect((await t.alerts.list(U1, { status: 'all', limit: 50, types: ['mint_reactivated'] })).items.every((alert) => alert.type === 'mint_reactivated')).toBe(true);
    expect((await t.alerts.list(U1, { status: 'all', limit: 50, mint: mint(0) })).items).toHaveLength(13);
    await expect(t.alerts.list(U1, { status: 'all', limit: 20, cursor: 'abc' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('lu / non lu par lot (autre compte ignoré), tout lu', async () => {
    const t = setup();
    seed(t, 3);
    seed(t, 1, U2);
    const ids = (t.prisma.tables['alert'] ?? []).slice(0, 2).map((row) => String(row['id']));
    expect(await t.alerts.markRead(U1, { ids, read: true })).toEqual({ unread: 1 });
    expect((await t.alerts.list(U1, { status: 'read', limit: 20 })).items).toHaveLength(2);
    expect(await t.alerts.markRead(U1, { ids: [ids[0] as string], read: false })).toEqual({ unread: 2 });
    expect(await t.alerts.markRead(U2, { ids, read: true })).toEqual({ unread: 1 });
    expect(await t.alerts.markRead(U1, { all: true, read: true })).toEqual({ unread: 0 });
    expect((await t.alerts.list(U1, { status: 'unread', limit: 20 })).items).toHaveLength(0);
  });

  it('curseur opaque : aller-retour, refus d’un curseur altéré', () => {
    const row = { createdAt: NOW, id: '01968b3a-7c2e-7d4a-9f00-000000000001' };
    expect(decodeCursor(encodeCursor(row))).toEqual(row);
    expect(decodeCursor(Buffer.from('x|y').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('pas-une-date|01968b3a-7c2e-7d4a-9f00-000000000001').toString('base64url'))).toBeNull();
  });
});

describe('préférences et push', () => {
  it('Gratuit : activer le push → PUSH_PLAN_REQUIRED ; le reste se règle', async () => {
    const t = setup();
    await expect(t.settings.update(U1, { pushAlerts: true })).rejects.toMatchObject({ code: 'PUSH_PLAN_REQUIRED', status: 403 });
    const settings = await t.settings.update(U1, { weeklyDigest: true, emailAlerts: false, pushAlerts: false });
    expect(settings).toEqual({
      preferences: { emailAlerts: false, pushAlerts: false, weeklyDigest: true },
      pushAllowed: false,
      pushConfigured: true,
      pushDevices: 0,
      emailVerified: true,
    });
  });

  it('abonnement : Gratuit refusé, Pro accepté, ré-abonnement idempotent, 10 appareils au plus, réattribution', async () => {
    const free = setup();
    const keys = { p256dh: KEY, auth: 'a'.repeat(22) };
    await expect(free.subscriptions.subscribe(U1, { endpoint: 'https://fcm.googleapis.com/x', keys }, null)).rejects.toMatchObject({ code: 'PUSH_PLAN_REQUIRED' });

    const pro = setup({ plan: 'PRO' });
    for (let index = 0; index < MAX_PUSH_SUBSCRIPTIONS + 2; index += 1) {
      await pro.subscriptions.subscribe(U1, { endpoint: `https://fcm.googleapis.com/fcm/send/${index}`, keys }, 'Navigateur');
    }
    expect(pro.prisma.tables['pushSubscription']).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
    expect(pro.prisma.tables['pushSubscription']?.map((row) => row['endpoint'])).not.toContain('https://fcm.googleapis.com/fcm/send/0');
    await pro.subscriptions.unsubscribe(U2, 'https://fcm.googleapis.com/fcm/send/5');
    expect(pro.prisma.tables['pushSubscription']).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
    await pro.subscriptions.unsubscribe(U1, 'https://fcm.googleapis.com/fcm/send/5');
    expect(pro.prisma.tables['pushSubscription']).toHaveLength(MAX_PUSH_SUBSCRIPTIONS - 1);
    expect(pro.subscriptions.publicKey()).toEqual({ publicKey: KEY });
  });

  it('sans clés VAPID : PUSH_NOT_SUPPORTED (503)', async () => {
    const prisma = new MemoryPrisma();
    const plans = new PlanLimitsService(prisma as unknown as PrismaService, clock, testConfig());
    const subscriptions = new PushSubscriptionsService(prisma as unknown as PrismaService, plans, new FakePushSender(null));
    expect(() => subscriptions.publicKey()).toThrow(expect.objectContaining({ code: 'PUSH_NOT_SUPPORTED' }));
    await expect(subscriptions.subscribe(U1, { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: KEY, auth: 'a'.repeat(22) } }, null)).rejects.toMatchObject({
      code: 'PUSH_NOT_SUPPORTED',
      status: 503,
    });
  });
});
