import { testConfig } from '@raijin/api-core';
import { FixtureScenarios } from '@raijin/api-analysis';
import { FakePushSender, WebPushSender } from '@raijin/api-notifications';
import type { PrismaService } from '@raijin/api-prisma';
import { pushSubscriptionRequestSchema } from '@raijin/shared-contracts';
import type { Response } from 'express';
import type { AlertsService } from '../alerts/alerts.service';
import type { AlertDeliveryService } from '../delivery/alert-delivery.service';
import type { JobHandlers } from '../jobs/job-handlers.service';
import type { NotificationSettingsService } from '../notifications/notification-settings.service';
import type { PushSubscriptionsService } from '../push/push-subscriptions.service';
import type { WatchesService } from '../watches/watches.service';
import { AlertsController, NotificationsController, PushController, PushSubscriptionPipe, WatchesController, WatchIdPipe } from './controllers';
import { InternalController } from './internal.controller';
import { JobRegistry } from '../jobs/job-registry';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ID = '01968b3a-7c2e-7d4a-9f00-000000000001';
const auth = { userId: ID, sessionId: 's', role: 'USER' as const, accessTokenExpiresAt: new Date() };

describe('pipes', () => {
  it('identifiant de suivi invalide : 404 WATCH_NOT_FOUND ; abonnement invalide : 400 PUSH_SUBSCRIPTION_INVALID', () => {
    expect(new WatchIdPipe().transform(ID)).toBe(ID);
    expect(() => new WatchIdPipe().transform('x')).toThrow(expect.objectContaining({ code: 'WATCH_NOT_FOUND' }));
    const pipe = new PushSubscriptionPipe(pushSubscriptionRequestSchema);
    expect(() => pipe.transform({ endpoint: 'https://evil.example/x', keys: {} })).toThrow(expect.objectContaining({ code: 'PUSH_SUBSCRIPTION_INVALID' }));
    expect(() => pipe.transform(undefined)).toThrow(expect.objectContaining({ code: 'PUSH_SUBSCRIPTION_INVALID' }));
  });
});

describe('contrôleurs (délégation aux services)', () => {
  it('suivis : 201 à la création, 200 si déjà suivi', async () => {
    const watches = {
      list: jest.fn(async () => ({})),
      create: jest.fn(async () => ({ watch: { id: ID }, created: true })),
      update: jest.fn(async () => ({})),
      remove: jest.fn(async () => undefined),
    };
    const controller = new WatchesController(watches as unknown as WatchesService);
    const res = { status: jest.fn() } as unknown as Response;
    await controller.list(auth);
    await controller.create(auth, { mint: MINT }, res);
    expect(res.status).toHaveBeenLastCalledWith(201);
    watches.create.mockResolvedValueOnce({ watch: { id: ID }, created: false });
    await controller.create(auth, { mint: MINT }, res);
    expect(res.status).toHaveBeenLastCalledWith(200);
    await controller.update(auth, ID, { status: 'paused' });
    await controller.remove(auth, ID);
    expect(watches.update).toHaveBeenCalledWith(ID, ID, 'paused');
    expect(watches.remove).toHaveBeenCalledWith(ID, ID);
  });

  it('alertes, préférences, push', async () => {
    const alerts = { list: jest.fn(), unreadCount: jest.fn(), markRead: jest.fn() };
    const alertsController = new AlertsController(alerts as unknown as AlertsService);
    await alertsController.list(auth, { status: 'all', limit: 20 });
    await alertsController.unread(auth);
    await alertsController.read(auth, { all: true, read: true });
    expect(alerts.markRead).toHaveBeenCalledWith(ID, { all: true, read: true });
    const settings = { settings: jest.fn(), update: jest.fn() };
    const notifications = new NotificationsController(settings as unknown as NotificationSettingsService);
    await notifications.get(auth);
    await notifications.update(auth, { weeklyDigest: true });
    expect(settings.update).toHaveBeenCalledWith(ID, { weeklyDigest: true });
    const subscriptions = { publicKey: jest.fn(() => ({ publicKey: 'k' })), subscribe: jest.fn(), unsubscribe: jest.fn() };
    const push = new PushController(subscriptions as unknown as PushSubscriptionsService);
    expect(push.publicKey()).toEqual({ publicKey: 'k' });
    const body = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } };
    await push.subscribe(auth, body, { ip: null, userAgent: 'UA' });
    expect(subscriptions.subscribe).toHaveBeenCalledWith(ID, body, 'UA');
    await push.unsubscribe(auth, { endpoint: body.endpoint });
    expect(subscriptions.unsubscribe).toHaveBeenCalledWith(ID, body.endpoint);
  });
});

describe('InternalController (tests e2e seulement)', () => {
  function setup(env: Record<string, string> = { JOBS_TEST_TRIGGER: '1' }, options: { scenarios?: FixtureScenarios | null; push?: FakePushSender | WebPushSender } = {}) {
    const handlers = { run: jest.fn(async () => ({ ok: 1 })) };
    const delivery = { pendingEmailUsers: jest.fn(async () => [ID]) };
    const prisma = { mintWatchState: { findMany: jest.fn(async () => [{ mint: MINT }]) } };
    const scenarios = options.scenarios === undefined ? new FixtureScenarios({ demo: [[], []] }, []) : options.scenarios;
    const registry = new JobRegistry();
    const extra = jest.fn(async () => ({ ticked: 1 }));
    registry.register({ name: 'trial-tick', queue: 'maintenance', handler: extra, manualRun: true });
    registry.register({ name: 'trial-email', queue: 'notify', handler: extra });
    const controller = new InternalController(
      testConfig(env),
      handlers as unknown as JobHandlers,
      delivery as unknown as AlertDeliveryService,
      prisma as unknown as PrismaService,
      options.push ?? new FakePushSender('cle'),
      registry,
      scenarios,
    );
    return { controller, handlers, delivery, registry, extra };
  }

  it('désactivé sans JOBS_TEST_TRIGGER : 404 partout', async () => {
    const { controller } = setup({});
    await expect(controller.run('purge', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() => controller.goTo('demo', { step: 1 })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => controller.outbox()).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('exécute les jobs : passes sur les mints donnés ou suivis, e-mails en attente, jobs simples', async () => {
    const { controller, handlers } = setup();
    expect((await controller.run('watch-fast', undefined)).results).toHaveLength(1);
    expect(handlers.run).toHaveBeenLastCalledWith('watch-fast', { mints: [MINT] });
    await controller.run('watch-holders', { mints: [MINT] });
    expect(handlers.run).toHaveBeenLastCalledWith('watch-holders', { mint: MINT });
    await controller.run('watch-full', {});
    await controller.run('alert-email', {});
    expect(handlers.run).toHaveBeenLastCalledWith('alert-email', { userId: ID });
    await controller.run('purge', {});
    expect(handlers.run).toHaveBeenLastCalledWith('purge', {});
    await expect(controller.run('alert-push', {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(controller.run('inconnu', {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(controller.run('purge', { mints: ['x'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('jobs déclarés (JobRegistry) : déclenchables seulement avec manualRun, corps vide', async () => {
    const { controller, extra } = setup();
    expect(await controller.run('trial-tick', {})).toEqual({ name: 'trial-tick', results: [{ ticked: 1 }] });
    expect(extra).toHaveBeenCalledWith({});
    await expect(controller.run('trial-tick', { now: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(controller.run('trial-email', {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(setup({}).controller.run('trial-tick', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fixtures en séquence et boîte d’envoi du push simulé', () => {
    const { controller } = setup();
    expect(controller.goTo('demo', { step: 1 })).toEqual({ scenario: 'demo', step: 1 });
    expect(() => controller.goTo('demo', { step: 5 })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => controller.goTo('demo', {})).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(controller.outbox()).toEqual({ items: [] });
    expect(() => setup(undefined, { scenarios: null }).controller.goTo('demo', { step: 0 })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => setup(undefined, { push: new WebPushSender(null) }).controller.outbox()).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
