import { testConfig } from '@raijin/api-core';
import { FakePushSender, type AlertMailService, type PushSender } from '@raijin/api-notifications';
import type { PrismaService } from '@raijin/api-prisma';
import { MemoryPrisma } from '../../testing/memory-prisma';
import type { EventRecorderService } from '../watch/event-recorder.service';
import { AlertDeliveryService, DeliveryRetryError } from './alert-delivery.service';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USER = '01968b3a-7c2e-7d4a-9f00-000000000001';
const KEY = `B${'A'.repeat(86)}`;
const A1 = '01968b3a-7c2e-7d4a-9f00-0000000000a1';
const payload = { revokedObservedAt: NOW.toISOString() };

function setup(options: { plan?: 'FREE' | 'PRO'; verified?: boolean; push?: PushSender; dailyMax?: string } = {}) {
  const prisma = new MemoryPrisma();
  prisma.tables['user']?.push({
    id: USER,
    email: 'trader@exemple.fr',
    emailVerifiedAt: options.verified === false ? null : NOW,
    plan: options.plan ?? 'PRO',
    trialStatus: 'NONE',
    trialEndsAt: null,
    notifyPushAlerts: true,
    notifyEmailAlerts: true,
  });
  const push = options.push ?? new FakePushSender(KEY);
  const mail = { sendAlerts: jest.fn(async () => undefined) };
  const recorder = { enqueueEmail: jest.fn(async () => undefined) };
  const service = new AlertDeliveryService(
    prisma as unknown as PrismaService,
    push,
    mail as unknown as AlertMailService,
    recorder as unknown as EventRecorderService,
    { now: () => NOW },
    testConfig({ ALERT_EMAIL_DAILY_MAX: options.dailyMax ?? '20' }),
  );
  const alert = (id: string, overrides: Record<string, unknown> = {}) =>
    prisma.tables['alert']?.push({ id, userId: USER, mint: MINT, type: 'mint_reactivated', severity: 'danger', payload, token: null, readAt: null, pushedAt: null, emailedAt: null, emailSkipped: false, createdAt: NOW, ...overrides });
  const subscribe = (endpoint: string) =>
    prisma.tables['pushSubscription']?.push({ id: endpoint, userId: USER, endpoint, p256dh: KEY, auth: 'a'.repeat(22), createdAt: NOW, lastSuccessAt: null });
  return { prisma, push, mail, recorder, service, alert, subscribe };
}

describe('AlertDeliveryService : push', () => {
  it('envoie à chaque appareil, supprime l’abonnement expiré (410), ne renvoie jamais deux fois', async () => {
    const t = setup();
    t.alert(A1);
    t.subscribe('https://fcm.googleapis.com/fcm/send/ok');
    t.subscribe('https://fcm.googleapis.com/fcm/send/gone');
    expect(await t.service.deliverPush(A1)).toEqual({ sent: 1, removed: 1, skipped: false });
    expect(t.prisma.tables['pushSubscription']?.map((row) => row['endpoint'])).toEqual(['https://fcm.googleapis.com/fcm/send/ok']);
    expect(t.prisma.tables['pushSubscription']?.[0]?.['lastSuccessAt']).toEqual(NOW);
    const sent = (t.push as FakePushSender).sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.options).toEqual({ ttlSeconds: 86_400, urgency: 'high' });
    expect(JSON.stringify(sent[0])).not.toContain('fcm.googleapis.com');
    expect(await t.service.deliverPush(A1)).toMatchObject({ skipped: true });
    expect((t.push as FakePushSender).sent()).toHaveLength(1);
  });

  it('panne passagère sur tous les appareils : réservation relâchée et reprise demandée', async () => {
    const t = setup();
    t.alert(A1);
    t.subscribe('https://fcm.googleapis.com/fcm/send/fail');
    await expect(t.service.deliverPush(A1)).rejects.toBeInstanceOf(DeliveryRetryError);
    expect(t.prisma.tables['alert']?.[0]?.['pushedAt']).toBeNull();
  });

  it('Gratuit, préférence coupée, push non configuré, aucune alerte : rien n’est envoyé', async () => {
    const free = setup({ plan: 'FREE' });
    free.alert(A1);
    free.subscribe('https://fcm.googleapis.com/fcm/send/ok');
    expect(await free.service.deliverPush(A1)).toMatchObject({ skipped: true });
    const noKeys = setup({ push: new FakePushSender(null) });
    noKeys.alert(A1);
    expect(await noKeys.service.deliverPush(A1)).toMatchObject({ skipped: true });
    expect(await setup().service.deliverPush('inconnue')).toMatchObject({ skipped: true });
    const off = setup();
    off.alert(A1);
    off.subscribe('https://fcm.googleapis.com/fcm/send/ok');
    if (off.prisma.tables['user']?.[0]) off.prisma.tables['user'][0]['notifyPushAlerts'] = false;
    expect(await off.service.deliverPush(A1)).toMatchObject({ skipped: true });
    const none = setup();
    none.alert(A1);
    expect(await none.service.deliverPush(A1)).toMatchObject({ skipped: true });
  });
});

describe('AlertDeliveryService : e-mail groupé', () => {
  function reserveRows(t: ReturnType<typeof setup> & { dailyMax: string }) {
    // Réservation atomique simulée : UPDATE … RETURNING des lignes en attente.
    t.prisma.rawHandler = (sql) => {
      if (sql.includes('UPDATE "Alert" SET "emailedAt"')) {
        const rows = (t.prisma.tables['alert'] ?? []).filter((row) => row['emailedAt'] === null && row['emailSkipped'] === false).slice(0, 20);
        for (const row of rows) row['emailedAt'] = NOW;
        return rows.map((row) => ({ ...row }));
      }
      if (sql.includes('INSERT INTO "UsageCounter"')) {
        const counter = (t.prisma.tables['usageCounter'] ??= []);
        const current = counter[0] ?? { count: 0 };
        if (!counter[0]) counter.push(current);
        if (Number(current['count']) >= Number(t.dailyMax)) return [];
        current['count'] = Number(current['count']) + 1;
        return [{ count: current['count'] }];
      }
      if (sql.includes('UPDATE "UsageCounter"')) {
        const current = t.prisma.tables['usageCounter']?.[0];
        if (current) current['count'] = Number(current['count']) - 1;
        return 1;
      }
      return [];
    };
  }

  function emailSetup(options: Parameters<typeof setup>[0] = {}) {
    const t = setup(options);
    const extended = Object.assign(t, { dailyMax: options.dailyMax ?? '20' });
    reserveRows(extended);
    return extended;
  }

  it('plusieurs alertes → un seul e-mail, réservées une seule fois', async () => {
    const t = emailSetup();
    t.alert('a1');
    t.alert('a2', { type: 'lp_removed', payload: { poolAddress: MINT, dex: 'raydium', dropPct: 42, liquidityUsdBefore: 1000, liquidityUsdAfter: 580, referenceAt: NOW.toISOString() } });
    expect(await t.service.deliverEmail(USER)).toEqual({ sent: true, alerts: 2, skipped: 0 });
    expect(t.mail.sendAlerts).toHaveBeenCalledTimes(1);
    expect(t.mail.sendAlerts).toHaveBeenCalledWith('trader@exemple.fr', expect.arrayContaining([expect.objectContaining({ id: 'a1' }), expect.objectContaining({ id: 'a2' })]));
    expect(await t.service.deliverEmail(USER)).toEqual({ sent: false, alerts: 0, skipped: 0 });
    expect(t.mail.sendAlerts).toHaveBeenCalledTimes(1);
  });

  it('plafond journalier atteint : alertes marquées non envoyées, jamais reprises', async () => {
    const t = emailSetup({ dailyMax: '1' });
    t.alert('a1');
    await t.service.deliverEmail(USER);
    t.alert('a2');
    expect(await t.service.deliverEmail(USER)).toEqual({ sent: false, alerts: 0, skipped: 1 });
    expect(t.prisma.tables['alert']?.[1]).toMatchObject({ emailedAt: null, emailSkipped: true });
    expect(t.mail.sendAlerts).toHaveBeenCalledTimes(1);
  });

  it('échec d’envoi : réservation et compteur relâchés, reprise demandée', async () => {
    const t = emailSetup();
    t.alert('a1');
    t.mail.sendAlerts.mockRejectedValueOnce(Object.assign(new Error('smtp'), { code: 'ECONNREFUSED' }));
    await expect(t.service.deliverEmail(USER)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(t.prisma.tables['alert']?.[0]?.['emailedAt']).toBeNull();
    expect(t.prisma.tables['usageCounter']?.[0]?.['count']).toBe(0);
  });

  it('e-mail non vérifié ou préférence coupée : alertes marquées non envoyées', async () => {
    const t = emailSetup({ verified: false });
    t.alert('a1');
    expect(await t.service.deliverEmail(USER)).toEqual({ sent: false, alerts: 0, skipped: 1 });
    expect(t.mail.sendAlerts).not.toHaveBeenCalled();
    expect(await t.service.deliverEmail('01968b3a-7c2e-7d4a-9f00-0000000000ff')).toMatchObject({ sent: false });
  });

  it('reliquat au-delà de 20 lignes : nouvel e-mail programmé ; utilisateurs en attente listés', async () => {
    const t = emailSetup();
    for (let index = 0; index < 22; index += 1) t.alert(`a${index}`);
    expect(await t.service.pendingEmailUsers()).toEqual([USER]);
    expect(await t.service.deliverEmail(USER)).toMatchObject({ alerts: 20 });
    expect(t.recorder.enqueueEmail).toHaveBeenCalledWith(USER, NOW);
  });
});
