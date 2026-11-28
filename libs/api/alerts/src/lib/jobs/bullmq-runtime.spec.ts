import { testConfig } from '@raijin/api-core';
import type { ModuleRef } from '@nestjs/core';
import { BullJobQueue, WEEKLY_DIGEST_CRON } from './bullmq-runtime.service';
import { JobHandlers } from './job-handlers.service';
import { JobRegistry } from './job-registry';

const queues: FakeQueue[] = [];
let failSchedule = false;
const workers: FakeWorker[] = [];

class FakeQueue {
  readonly add = jest.fn(async () => undefined);
  readonly upsertJobScheduler = jest.fn(async () => {
    if (failSchedule) throw new Error('redis');
  });
  readonly removeJobScheduler = jest.fn(async () => true);
  readonly close = jest.fn(async () => undefined);
  constructor(readonly name: string, readonly options: Record<string, unknown>) {
    queues.push(this);
  }
}

class FakeWorker {
  readonly handlers = new Map<string, (...args: unknown[]) => void>();
  readonly close = jest.fn(async () => undefined);
  constructor(readonly name: string, readonly processor: (job: { name: string; data: unknown }) => Promise<unknown>, readonly options: Record<string, unknown>) {
    workers.push(this);
  }
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler);
    return this;
  }
}

jest.mock('bullmq', () => ({ Queue: jest.fn((name: string, options: Record<string, unknown>) => new FakeQueue(name, options)), Worker: jest.fn((name: string, processor: never, options: Record<string, unknown>) => new FakeWorker(name, processor, options)) }));
jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => {
    const handlers = new Map<string, (error: Error) => void>();
    return { on: (event: string, handler: (error: Error) => void) => handlers.set(event, handler), disconnect: jest.fn(), emit: (error: Error) => handlers.get('error')?.(error) };
  }),
);

function setup(env: Record<string, string> = {}) {
  queues.length = 0;
  workers.length = 0;
  const handlers = { run: jest.fn(async () => ({ done: true })) };
  const registry = new JobRegistry();
  const extra = jest.fn(async () => ({ extra: true }));
  registry.register({ name: 'trial-tick', queue: 'maintenance', handler: extra, scheduler: { pattern: '5 * * * *', tz: 'UTC' } });
  const moduleRef = { get: jest.fn((token: unknown) => (token === JobRegistry ? registry : handlers)) } as unknown as ModuleRef;
  const queue = new BullJobQueue(testConfig({ JOBS_ENABLED: 'true', REDIS_URL: 'redis://127.0.0.1:6380', ...env }), moduleRef);
  const start = async () => {
    await queue.onModuleInit();
    await queue.onApplicationBootstrap();
  };
  return { queue, handlers, moduleRef, extra, start, registry };
}

describe('BullJobQueue', () => {
  it('5 files et workers (préfixe, concurrence), planifications persistantes', async () => {
    const { queue, moduleRef, start } = setup({ BULLMQ_PREFIX: 'raijin-test' });
    await start();
    expect(moduleRef.get).toHaveBeenCalledWith(JobHandlers, { strict: false });
    expect(moduleRef.get).toHaveBeenCalledWith(JobRegistry, { strict: false });
    expect(queues.map((entry) => entry.name)).toEqual(['watch', 'watch-holders', 'watch-full', 'notify', 'maintenance']);
    expect(workers.map((worker) => worker.options['concurrency'])).toEqual([1, 2, 1, 4, 1]);
    expect(queues[0]?.options['prefix']).toBe('raijin-test');
    const watch = queues[0];
    const maintenance = queues[4];
    expect(watch?.upsertJobScheduler).toHaveBeenCalledWith('watch-planner', { every: 60_000 }, expect.objectContaining({ name: 'watch-planner' }));
    expect(maintenance?.upsertJobScheduler).toHaveBeenCalledWith('purge', { pattern: '30 3 * * *', tz: 'UTC' }, expect.anything());
    expect(maintenance?.upsertJobScheduler).toHaveBeenCalledWith('weekly-digest', { pattern: WEEKLY_DIGEST_CRON, tz: 'Europe/Paris' }, expect.anything());
    expect(maintenance?.upsertJobScheduler).toHaveBeenCalledWith('trial-tick', { pattern: '5 * * * *', tz: 'UTC' }, { name: 'trial-tick', data: {} });
    await queue.onApplicationShutdown();
    expect(workers.every((worker) => worker.close.mock.calls.length === 1)).toBe(true);
  });

  it('JOBS_TEST_TRIGGER=1 : planifications retirées', async () => {
    const { start } = setup({ JOBS_TEST_TRIGGER: '1' });
    await start();
    expect(queues[0]?.removeJobScheduler).toHaveBeenCalledWith('watch-planner');
    expect(queues[4]?.removeJobScheduler).toHaveBeenCalledWith('purge');
    expect(queues[4]?.removeJobScheduler).toHaveBeenCalledWith('trial-tick');
    expect(queues[0]?.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('planification impossible : journalisée, jamais d’exception au démarrage', async () => {
    const { queue } = setup();
    failSchedule = true;
    try {
      await expect(queue.onModuleInit()).resolves.toBeUndefined();
      await expect(queue.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(queues[0]?.upsertJobScheduler).toHaveBeenCalled();
    } finally {
      failSchedule = false;
    }
  });

  it('mise en file : jobId, délai, priorité ; Redis en panne → avertissement seulement', async () => {
    const { queue } = setup();
    await queue.onModuleInit();
    await queue.add('watch-full', { mint: 'm' }, { jobId: 'full-m-1', priority: 1, delayMs: 10 });
    expect(queues[2]?.add).toHaveBeenCalledWith('watch-full', { mint: 'm' }, { jobId: 'full-m-1', delay: 10, priority: 1 });
    await queue.add('alert-push', { alertId: 'a' });
    expect(queues[3]?.add).toHaveBeenCalledWith('alert-push', { alertId: 'a' }, {});
    queues[3]?.add.mockRejectedValueOnce(new Error('down'));
    await expect(queue.add('alert-email', { userId: 'u' })).resolves.toBeUndefined();
    await queue.add('trial-tick', {}, { jobId: 'tick' });
    expect(queues[4]?.add).toHaveBeenCalledWith('trial-tick', {}, { jobId: 'tick' });
    await expect(queue.add('inconnu', {})).resolves.toBeUndefined();
  });

  it('worker : exécute le job par son nom, ignore un nom inconnu ; événements d’échec journalisés', async () => {
    const { queue, handlers, extra } = setup();
    await queue.onModuleInit();
    const worker = workers[0];
    await expect(worker?.processor({ name: 'watch-planner', data: undefined })).resolves.toEqual({ done: true });
    expect(handlers.run).toHaveBeenCalledWith('watch-planner', {});
    await expect(worker?.processor({ name: 'inconnu', data: {} })).resolves.toEqual({ ignored: true });
    await expect(worker?.processor({ name: 'trial-tick', data: { now: 'x' } })).resolves.toEqual({ extra: true });
    expect(extra).toHaveBeenCalledWith({ now: 'x' });
    expect(() => worker?.handlers.get('failed')?.({ name: 'watch-planner' }, new Error('x'))).not.toThrow();
    expect(() => worker?.handlers.get('failed')?.(undefined, new Error('x'))).not.toThrow();
    expect(() => worker?.handlers.get('error')?.(new Error('x'))).not.toThrow();
  });

  it('avant démarrage : mise en file sans effet', async () => {
    const { queue } = setup();
    await expect(queue.add('purge', {})).resolves.toBeUndefined();
  });
});

describe('JobRegistry', () => {
  it('refuse un nom invalide, un nom de base ou un doublon', () => {
    const registry = new JobRegistry();
    const handler = async () => ({});
    expect(() => registry.register({ name: 'Mauvais nom', queue: 'maintenance', handler })).toThrow();
    expect(() => registry.register({ name: 'purge', queue: 'maintenance', handler })).toThrow();
    registry.register({ name: 'trial-tick', queue: 'maintenance', handler });
    expect(() => registry.register({ name: 'trial-tick', queue: 'maintenance', handler })).toThrow();
    expect(registry.get('trial-tick')?.queue).toBe('maintenance');
    expect(registry.all()).toHaveLength(1);
  });
});
