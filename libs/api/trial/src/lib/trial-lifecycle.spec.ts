import { MemoryKeyValueStore } from '@raijin/api-analysis';
import { jobId, JobRegistry, JobRunService, RecordingJobQueue, type WatchesService } from '@raijin/api-alerts';
import { testConfig } from '@raijin/api-core';
import type { TrialMailService } from '@raijin/api-notifications';
import type { PrismaService } from '@raijin/api-prisma';
import type { TrialRecap } from '@raijin/shared-contracts';
import { MemoryDb } from '../testing/memory-db';
import { parisHour, TRIAL_TICK_LOCK_KEY, TrialLifecycleService } from './trial-lifecycle.service';
import type { TrialRecapService } from './trial-recap.service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Lundi 23 novembre 2026, 8 h UTC = 9 h à Paris (heure d'hiver). */
const START = new Date('2026-11-23T08:00:00.000Z');
const END = new Date(START.getTime() + 7 * DAY);
const at = (ms: number) => new Date(START.getTime() + ms);

const RECAP: TrialRecap = {
  status: 'active',
  startedAt: START.toISOString(),
  endsAt: END.toISOString(),
  analysesCount: 12,
  alertsCount: 3,
  dangerTokensCount: 2,
  walletScansCount: 1,
  activeWatches: 5,
  planLimitPausedWatches: 0,
};

function setup(env: Record<string, string> = { JOBS_TEST_TRIGGER: '1' }) {
  const db = new MemoryDb();
  const watches = {
    enforcePlanLimitInTx: jest.fn(async () => ({ count: 2, mints: ['m4', 'm5'] })),
    refreshPriorities: jest.fn(async () => undefined),
  };
  const queue = new RecordingJobQueue();
  const registry = new JobRegistry();
  const store = new MemoryKeyValueStore();
  const mail = { sendDay1: jest.fn(async () => undefined), sendDayMinus2: jest.fn(async () => undefined), sendEnded: jest.fn(async () => undefined) };
  const recaps = { recap: jest.fn(async () => RECAP) };
  const config = testConfig(env);
  const service = new TrialLifecycleService(
    db as unknown as PrismaService,
    watches as unknown as WatchesService,
    queue,
    registry,
    new JobRunService(db as unknown as PrismaService),
    store,
    mail as unknown as TrialMailService,
    recaps as unknown as TrialRecapService,
    config,
  );
  service.onModuleInit();
  const trialUser = (overrides: Record<string, unknown> = {}) => db.addUser({ trialStatus: 'ACTIVE', trialStartedAt: START, trialEndsAt: END, ...overrides });
  const jobs = (kind?: string) => queue.jobs.filter((job) => job.name === 'trial-email' && (!kind || job.data['kind'] === kind));
  return { db, watches, queue, registry, store, mail, recaps, service, trialUser, jobs, config };
}

describe('parisHour', () => {
  it('heure de Paris, été comme hiver', () => {
    expect(parisHour(new Date('2026-12-01T09:00:00Z'))).toBe(10);
    expect(parisHour(new Date('2026-07-01T08:00:00Z'))).toBe(10);
    expect(parisHour(new Date('2026-07-01T22:30:00Z'))).toBe(0);
  });
});

describe('job trial-tick : horloge simulée', () => {
  it('J+1 : pas avant 24 h, pas avant 10 h à Paris, une seule fois', async () => {
    const { service, trialUser, jobs, db } = setup();
    const user = trialUser();
    expect(await service.tick(at(23 * HOUR))).toMatchObject({ day1: 0 });
    // +24 h = 8 h UTC = 9 h à Paris : éligible mais trop tôt.
    expect(await service.tick(at(24 * HOUR))).toMatchObject({ day1: 0 });
    expect(await service.tick(at(25 * HOUR))).toMatchObject({ day1: 1, dayMinus2: 0, expired: 0 });
    expect(jobs('day1')).toEqual([{ name: 'trial-email', data: { userId: user['id'], kind: 'day1' }, options: { jobId: jobId('trial-day1', user['id'] as string) } }]);
    expect(db.user.rows[0]?.['trialDay1MailAt']).toEqual(at(25 * HOUR));
    expect(await service.tick(at(26 * HOUR))).toMatchObject({ day1: 0 });
    expect(jobs('day1')).toHaveLength(1);
  });

  it('J-2 : à partir de 48 h avant la fin et de 10 h à Paris, une seule fois ; plus de J+1 si trop tard', async () => {
    const { service, trialUser, jobs } = setup();
    trialUser();
    const minus2 = END.getTime() - START.getTime() - 2 * DAY;
    expect(await service.tick(at(minus2 - HOUR))).toMatchObject({ dayMinus2: 0 });
    expect(await service.tick(at(minus2 + 5 * 60_000))).toMatchObject({ dayMinus2: 0 }); // 9 h 05 à Paris
    expect(await service.tick(at(minus2 + HOUR + 5 * 60_000))).toMatchObject({ dayMinus2: 1, day1: 0 });
    expect(await service.tick(at(minus2 + 2 * HOUR))).toMatchObject({ dayMinus2: 0 });
    expect(jobs('dayMinus2')).toHaveLength(1);
    expect(jobs('day1')).toHaveLength(0);
  });

  it('préférence trialEmails désactivée : ni J+1 ni J-2, mais J0 toujours', async () => {
    const { service, trialUser, jobs } = setup();
    trialUser({ notifyTrialEmails: false });
    await service.tick(at(25 * HOUR));
    await service.tick(at(5 * DAY + 2 * HOUR));
    expect(jobs('day1')).toHaveLength(0);
    expect(jobs('dayMinus2')).toHaveLength(0);
    expect(await service.tick(at(7 * DAY + 5 * 60_000))).toMatchObject({ expired: 1, ended: 1 });
    expect(jobs('ended')).toHaveLength(1);
  });

  it('expiration : ENDED, limite Gratuite (suivis en pause, jamais supprimés), trial_expired, J0 une seule fois', async () => {
    const { service, trialUser, jobs, db, watches } = setup();
    const user = trialUser();
    expect(await service.tick(at(7 * DAY - 1))).toMatchObject({ expired: 0 });
    const result = await service.tick(at(7 * DAY + 5 * 60_000));
    expect(result).toMatchObject({ expired: 1, pausedWatches: 2, ended: 1 });
    expect(db.user.rows[0]).toMatchObject({ trialStatus: 'ENDED', trialEndMailAt: at(7 * DAY + 5 * 60_000) });
    expect(watches.enforcePlanLimitInTx).toHaveBeenCalledWith(db, user['id']);
    expect(watches.refreshPriorities).toHaveBeenCalledWith(['m4', 'm5']);
    expect(db.productEvent.rows).toEqual([expect.objectContaining({ userId: user['id'], type: 'trial_expired', properties: { pausedWatches: 2 } })]);
    expect(jobs('ended')).toEqual([{ name: 'trial-email', data: { userId: user['id'], kind: 'ended' }, options: { jobId: jobId('trial-j0', user['id'] as string) } }]);
    expect(await service.tick(at(8 * DAY))).toMatchObject({ expired: 0, ended: 0 });
    expect(jobs('ended')).toHaveLength(1);
    expect(db.jobRun.rows.filter((row) => row['job'] === 'trial-tick')).toHaveLength(3);
  });

  it('job en retard de plusieurs heures : expiration rattrapée au passage suivant', async () => {
    const { service, trialUser, db } = setup();
    trialUser();
    trialUser({ trialEndsAt: new Date(END.getTime() - 3 * HOUR) });
    expect(await service.tick(at(7 * DAY + 6 * HOUR))).toMatchObject({ expired: 2 });
    expect(db.user.rows.every((row) => row['trialStatus'] === 'ENDED')).toBe(true);
  });

  it('abonné Pro dont l’essai expire : ENDED sans e-mail J0', async () => {
    const { service, trialUser, jobs } = setup();
    trialUser({ plan: 'PRO' });
    expect(await service.tick(at(7 * DAY + HOUR))).toMatchObject({ expired: 1, ended: 0 });
    expect(jobs('ended')).toHaveLength(0);
  });

  it('erreur sur un compte (rollback) : les autres sont traités, le compte en erreur repris ensuite', async () => {
    const { service, trialUser, db } = setup();
    trialUser();
    trialUser();
    db.failNextTransaction = true;
    expect(await service.tick(at(7 * DAY + HOUR))).toMatchObject({ expired: 1 });
    expect(db.user.rows.filter((row) => row['trialStatus'] === 'ACTIVE')).toHaveLength(1);
    expect(await service.tick(at(7 * DAY + 2 * HOUR))).toMatchObject({ expired: 1 });
  });

  it('verrou déjà pris : aucune exécution concurrente', async () => {
    const { service, store, trialUser, db } = setup();
    trialUser();
    await store.setIfAbsent(TRIAL_TICK_LOCK_KEY, 'autre', 60_000);
    expect(await service.tick(at(7 * DAY + HOUR))).toEqual({ locked: true });
    expect(db.user.rows[0]?.['trialStatus']).toBe('ACTIVE');
  });

  it('horloge simulée limitée à un compte (tests e2e) : les autres essais ne bougent pas', async () => {
    const { service, trialUser, db } = setup();
    const mine = trialUser();
    trialUser();
    expect(await service.tick(at(7 * DAY + HOUR), mine['id'] as string)).toMatchObject({ expired: 1 });
    expect(db.user.rows.map((row) => row['trialStatus'])).toEqual(['ENDED', 'ACTIVE']);
  });

  it('comptes non vérifiés, inéligibles ou sans essai : ignorés', async () => {
    const { service, db, jobs } = setup();
    db.addUser();
    db.addUser({ trialStatus: 'INELIGIBLE' });
    db.addUser({ trialStatus: 'ACTIVE', trialStartedAt: START, trialEndsAt: END, emailVerifiedAt: null });
    await service.tick(at(25 * HOUR));
    expect(jobs()).toHaveLength(0);
  });
});

describe('jobs déclarés', () => {
  it('trial-tick planifié (TRIAL_JOB_CRON), déclenchable en test avec une horloge simulée ; trial-email sur la file notify', async () => {
    const { registry, trialUser, db } = setup();
    trialUser();
    expect(registry.get('trial-tick')).toMatchObject({ queue: 'maintenance', scheduler: { pattern: '5 * * * *', tz: 'UTC' }, manualRun: true });
    expect(registry.get('trial-email')).toMatchObject({ queue: 'notify' });
    expect(await registry.get('trial-tick')?.handler({ now: at(7 * DAY + HOUR).toISOString() })).toMatchObject({ expired: 1 });
    expect(db.user.rows[0]?.['trialStatus']).toBe('ENDED');
    await expect(registry.get('trial-email')?.handler({ userId: 'pas-un-uuid', kind: 'day1' })).rejects.toThrow();
  });

  it('hors mode test : l’horloge du job est toujours l’heure réelle', async () => {
    const { registry, trialUser, db } = setup({});
    trialUser({ trialStartedAt: new Date(), trialEndsAt: new Date(Date.now() + 7 * DAY) });
    await registry.get('trial-tick')?.handler({ now: new Date(Date.now() + 30 * DAY).toISOString() });
    expect(db.user.rows[0]?.['trialStatus']).toBe('ACTIVE');
  });
});

describe('e-mails d’essai (job trial-email)', () => {
  it('J+1 et J-2 : récapitulatif ; plus rien si l’essai est fini ou la préférence coupée entre-temps', async () => {
    const { service, trialUser, mail, db } = setup();
    const user = trialUser();
    const id = user['id'] as string;
    expect(await service.sendEmail(id, 'day1', at(25 * HOUR))).toEqual({ sent: true });
    expect(mail.sendDay1).toHaveBeenCalledWith(user['email'], RECAP);
    expect(await service.sendEmail(id, 'dayMinus2', at(5 * DAY + 2 * HOUR))).toEqual({ sent: true });
    expect(mail.sendDayMinus2).toHaveBeenCalledWith(user['email'], RECAP, END, expect.objectContaining({ maxActiveWatches: 3, analysesPerDay: 5 }));
    (db.user.rows[0] as Record<string, unknown>)['notifyTrialEmails'] = false;
    expect(await service.sendEmail(id, 'day1', at(25 * HOUR))).toEqual({ sent: false });
    expect(await service.sendEmail(id, 'ended', at(8 * DAY))).toEqual({ sent: true });
    expect(mail.sendEnded).toHaveBeenCalledWith(user['email'], RECAP, expect.objectContaining({ walletScansPerDay: 0, pushAlerts: false }));
    expect(await service.sendEmail(id, 'dayMinus2', at(8 * DAY))).toEqual({ sent: false });
    expect(await service.sendEmail('00000000-0000-7000-8000-000000000000', 'ended')).toEqual({ sent: false });
  });

  it('J0 : pas envoyé si le compte est devenu Pro avant l’envoi (relecture en base)', async () => {
    const { service, trialUser, mail } = setup();
    const user = trialUser({ trialStatus: 'ENDED', plan: 'PRO' });
    expect(await service.sendEmail(user['id'] as string, 'ended', at(8 * DAY))).toEqual({ sent: false });
    expect(mail.sendEnded).not.toHaveBeenCalled();
  });

  it('échec d’envoi : l’erreur remonte (BullMQ réessaie avec le même jobId)', async () => {
    const { service, trialUser, mail } = setup();
    const user = trialUser({ trialStatus: 'ENDED' });
    mail.sendEnded.mockRejectedValueOnce(new Error('smtp'));
    await expect(service.sendEmail(user['id'] as string, 'ended', at(8 * DAY))).rejects.toThrow('smtp');
  });
});

describe('écran de fin et conversion', () => {
  it('end-screen/seen : posé une fois ; 404 TRIAL_NOT_FOUND sans essai', async () => {
    const { service, trialUser, db } = setup();
    const user = trialUser();
    await service.markEndScreenSeen(user['id'] as string, at(7 * DAY));
    await service.markEndScreenSeen(user['id'] as string, at(8 * DAY));
    expect(db.user.rows[0]?.['trialEndScreenSeenAt']).toEqual(at(7 * DAY));
    const none = db.addUser();
    await expect(service.markEndScreenSeen(none['id'] as string)).rejects.toMatchObject({ code: 'TRIAL_NOT_FOUND', status: 404 });
  });

  it('abonnement pendant l’essai : essai terminé tout de suite, trial_converted {during} une seule fois', async () => {
    const { service, trialUser, db } = setup();
    const user = trialUser();
    const now = at(3 * DAY);
    expect(await service.endTrialOnSubscription(user['id'] as string, 'year', now)).toBe('during');
    expect(db.user.rows[0]).toMatchObject({ trialStatus: 'ENDED', trialEndsAt: now });
    expect(db.productEvent.rows).toEqual([expect.objectContaining({ type: 'trial_converted', properties: { phase: 'during', interval: 'year' } })]);
    expect(await service.endTrialOnSubscription(user['id'] as string, 'year', at(3 * DAY + 1))).toBeNull();
    expect(db.productEvent.rows).toHaveLength(1);
  });

  it('abonnement après l’essai : {after} dans la fenêtre de 30 jours, rien au-delà ni sans essai', async () => {
    const { service, db } = setup();
    const ended = db.addUser({ trialStatus: 'ENDED', trialStartedAt: START, trialEndsAt: END });
    const late = db.addUser({ trialStatus: 'ENDED', trialStartedAt: START, trialEndsAt: END });
    const lagging = db.addUser({ trialStatus: 'ACTIVE', trialStartedAt: START, trialEndsAt: END });
    const never = db.addUser();
    expect(await service.endTrialOnSubscription(ended['id'] as string, 'month', new Date(END.getTime() + 10 * DAY))).toBe('after');
    expect(await service.endTrialOnSubscription(late['id'] as string, 'month', new Date(END.getTime() + 31 * DAY))).toBeNull();
    expect(await service.endTrialOnSubscription(lagging['id'] as string, 'month', new Date(END.getTime() + HOUR))).toBe('after');
    expect(lagging['trialStatus']).toBe('ENDED');
    expect(await service.endTrialOnSubscription(never['id'] as string, 'month')).toBeNull();
  });

  it('routes de l’horloge simulée : 404 hors JOBS_TEST_TRIGGER ou en production', () => {
    expect(() => setup().service.assertTestClock()).not.toThrow();
    expect(() => setup({}).service.assertTestClock()).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
