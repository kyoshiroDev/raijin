import { testConfig } from '@raijin/api-core';
import { ModuleRef } from '@nestjs/core';
import { createJobQueue } from '../api-alerts.module';
import { BullJobQueue } from './bullmq-runtime.service';
import { JobHandlers } from './job-handlers.service';
import { DisabledJobQueue, JOB_NAMES, jobId, QUEUE_OF, RecordingJobQueue } from './job-queue';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('files de jobs', () => {
  it('jobId sans « : » (refusé par BullMQ), segments assainis', () => {
    expect(jobId('holders', MINT, 42)).toBe(`holders-${MINT}-42`);
    expect(jobId('email', 'a:b/c')).toBe('email-a_b_c');
  });

  it('chaque job a sa file ; la file d’enregistrement ignore un doublon de jobId', async () => {
    for (const name of JOB_NAMES) expect(QUEUE_OF[name]).toBeDefined();
    const queue = new RecordingJobQueue();
    await queue.add('watch-full', { mint: MINT }, { jobId: 'x' });
    await queue.add('watch-full', { mint: MINT }, { jobId: 'x' });
    expect(queue.jobs).toHaveLength(1);
    await expect(new DisabledJobQueue().add()).resolves.toBeUndefined();
  });

  it('BullMQ seulement si les jobs sont activés et Redis configuré', () => {
    const moduleRef = {} as ModuleRef;
    expect(createJobQueue(testConfig(), moduleRef)).toBeInstanceOf(DisabledJobQueue);
    expect(createJobQueue(testConfig({ JOBS_ENABLED: 'true', REDIS_URL: 'redis://127.0.0.1:1' }), moduleRef)).toBeInstanceOf(BullJobQueue);
  });
});

describe('JobHandlers', () => {
  function setup() {
    const planner = { tick: jest.fn(async () => ({ mints: 0 })) };
    const passes = { fast: jest.fn(async () => ({})), holders: jest.fn(async () => ({})), full: jest.fn(async () => ({})) };
    const delivery = { deliverPush: jest.fn(async () => ({})), deliverEmail: jest.fn(async () => ({})) };
    const digest = { run: jest.fn(async () => ({})) };
    const purge = { run: jest.fn(async () => ({})) };
    const handlers = new JobHandlers(planner as never, passes as never, delivery as never, digest as never, purge as never);
    return { handlers, planner, passes, delivery, digest, purge };
  }

  it('route chaque job vers son service', async () => {
    const t = setup();
    const uuid = '01968b3a-7c2e-7d4a-9f00-000000000001';
    await t.handlers.run('watch-planner', {});
    await t.handlers.run('watch-fast', { mints: [MINT] });
    await t.handlers.run('watch-holders', { mint: MINT });
    await t.handlers.run('watch-full', { mint: MINT });
    await t.handlers.run('alert-push', { alertId: uuid });
    await t.handlers.run('alert-email', { userId: uuid });
    await t.handlers.run('weekly-digest', {});
    await t.handlers.run('purge', {});
    expect(t.planner.tick).toHaveBeenCalled();
    expect(t.passes.fast).toHaveBeenCalledWith([MINT]);
    expect(t.passes.holders).toHaveBeenCalledWith(MINT);
    expect(t.passes.full).toHaveBeenCalledWith(MINT);
    expect(t.delivery.deliverPush).toHaveBeenCalledWith(uuid);
    expect(t.delivery.deliverEmail).toHaveBeenCalledWith(uuid);
    expect(t.digest.run).toHaveBeenCalled();
    expect(t.purge.run).toHaveBeenCalled();
  });

  it('données de job altérées : refusées (Zod), aucun service appelé', async () => {
    const t = setup();
    await expect(t.handlers.run('watch-full', { mint: 'pas-une-adresse' })).rejects.toThrow();
    await expect(t.handlers.run('alert-email', { userId: 'x' })).rejects.toThrow();
    expect(t.passes.full).not.toHaveBeenCalled();
  });
});
