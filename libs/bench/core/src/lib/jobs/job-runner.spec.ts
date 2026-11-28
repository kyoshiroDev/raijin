import { jobRunSchema, type BenchEvent } from '@raijin/bench-contracts';
import { MemoryJobRunStore } from '../../testing/memory-job-run-store';
import { TestClock, testConfig } from '../../testing/test-app';
import { BenchEventBus } from '../sse/event-bus';
import { MemoryJobLock, RedisBenchJobLock } from './job-lock';
import { BenchJobRegistry } from './job-registry';
import { BenchJobRunner } from './job-runner.service';
import type { BenchRedis } from '../redis/bench-redis';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe('BenchJobRunner', () => {
  function setup(lock = new MemoryJobLock()) {
    const registry = new BenchJobRegistry();
    const runs = new MemoryJobRunStore();
    const bus = new BenchEventBus();
    const events: BenchEvent[] = [];
    bus.events().subscribe((event) => events.push(event));
    const clock = new TestClock();
    const runner = new BenchJobRunner(registry, lock, runs, bus, testConfig(), clock.now);
    return { registry, runs, events, clock, runner };
  }

  it('deux exécutions concurrentes du même job : une seule tourne, l’autre est journalisée skipped', async () => {
    const { registry, runs, runner, events } = setup();
    const gate = deferred();
    let calls = 0;
    registry.register('scan-tokens', async () => {
      calls += 1;
      await gate.promise;
      return { scanned: 3 };
    });
    const first = runner.run('scan-tokens');
    const second = await runner.run('scan-tokens');
    expect(second.status).toBe('skipped');
    gate.resolve();
    const done = await first;
    expect(done.status).toBe('success');
    expect(calls).toBe(1);
    expect(runs.rows.map((row) => row.status).sort()).toEqual(['skipped', 'success']);
    expect(runs.rows.find((row) => row.status === 'skipped')?.details).toEqual({ reason: 'overlap' });
    expect(runs.rows.find((row) => row.status === 'success')?.details).toEqual({ scanned: 3 });
    expect(events.filter((event) => event.type === 'job.finished')).toHaveLength(2);
    // Verrou libéré : une nouvelle exécution passe.
    expect((await runner.run('scan-tokens')).status).toBe('success');
  });

  it('échec : statut failed, durée, erreur tronquée à 500 caractères et sans secret', async () => {
    const { registry, runner, clock } = setup();
    registry.register('enrich-tokens', async () => {
      clock.advance(1_234);
      throw new Error(
        `fetch https://mainnet.helius-rpc.com/?api-key=abcd1234secret échoué ; postgresql://raijin_bench:motdepasse@raijin-postgres/raijin_bench ; Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig ; BENCH_HELIUS_API_KEY=cle-secrete ${'x'.repeat(900)}`,
      );
    });
    const outcome = await runner.run('enrich-tokens');
    if (outcome.status !== 'failed') throw new Error('échec attendu');
    const run = jobRunSchema.parse(outcome.run);
    expect(run.duration_ms).toBe(1_234);
    expect(run.error?.length).toBeLessThanOrEqual(500);
    for (const secret of ['abcd1234secret', 'motdepasse', 'eyJhbGciOiJIUzI1NiJ9', 'cle-secrete']) expect(run.error).not.toContain(secret);
    expect(run.error).toContain('api-key=***');
  });

  it('job non branché : journalisé skipped (not_registered) ; un job ne s’enregistre qu’une fois', async () => {
    const { registry, runner, runs } = setup();
    expect((await runner.run('storage-check')).status).toBe('skipped');
    expect(runs.rows[0]?.details).toEqual({ reason: 'not_registered' });
    registry.register('storage-check', async () => undefined);
    expect(() => registry.register('storage-check', async () => undefined)).toThrow('déjà enregistré');
    expect((await runner.run('storage-check', 'manual')).status).toBe('success');
  });

  it('journal indisponible : rien n’est lancé, verrou libéré', async () => {
    const { registry, runner, runs } = setup();
    let calls = 0;
    registry.register('label-outcomes', async () => {
      calls += 1;
    });
    jest.spyOn(runs, 'start').mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
    expect(await runner.run('label-outcomes')).toEqual({ status: 'not_recorded', reason: 'job_runs_unavailable' });
    expect(calls).toBe(0);
    expect((await runner.run('label-outcomes')).status).toBe('success');
  });

  it('les lignes running d’un processus arrêté passent en failed au démarrage', async () => {
    const { runs, clock } = setup();
    await runs.start('paper-engine', clock.now());
    clock.advance(1_000);
    expect(await runs.markInterrupted(clock.now(), clock.now())).toBe(1);
    expect(runs.rows[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('Interrompu') });
    expect((await runs.health()).find((item) => item.job === 'paper-engine')).toMatchObject({ last_status: 'failed', consecutive_failures: 1, last_success_at: null });
  });
});

describe('RedisBenchJobLock', () => {
  class FakeRedis {
    readonly store = new Map<string, string>();
    async set(key: string, value: string, _px: string, _ttl: number, nx: string): Promise<'OK' | null> {
      if (nx === 'NX' && this.store.has(key)) return null;
      this.store.set(key, value);
      return 'OK';
    }
    async eval(script: string, _keys: number, key: string, token: string): Promise<number> {
      if (this.store.get(key) !== token) return 0;
      if (script.includes('DEL')) this.store.delete(key);
      return 1;
    }
  }

  it('SET NX à jeton : second verrou refusé, prolongation et libération par le seul détenteur', async () => {
    const fake = new FakeRedis();
    const lock = new RedisBenchJobLock({ prefixed: fake, warn: () => undefined } as unknown as BenchRedis);
    const token = await lock.acquire('scan-tokens', 60_000);
    expect(token).not.toBeNull();
    expect([...fake.store.keys()]).toEqual(['lock:job:scan-tokens']);
    expect(await lock.acquire('scan-tokens', 60_000)).toBeNull();
    expect(await lock.extend('scan-tokens', token as string, 60_000)).toBe(true);
    await lock.release('scan-tokens', 'autre-jeton');
    expect(fake.store.size).toBe(1);
    await lock.release('scan-tokens', token as string);
    expect(fake.store.size).toBe(0);
  });

  it('Redis en panne : repli sur le verrou en mémoire (toujours exclusif)', async () => {
    const broken = { set: async () => Promise.reject(new Error('down')), eval: async () => Promise.reject(new Error('down')) };
    const warnings: string[] = [];
    const lock = new RedisBenchJobLock({ prefixed: broken, warn: (message: string) => warnings.push(message) } as unknown as BenchRedis);
    const token = await lock.acquire('scan-tokens', 60_000);
    expect(token).not.toBeNull();
    expect(await lock.acquire('scan-tokens', 60_000)).toBeNull();
    expect(warnings).toHaveLength(2);
    await lock.release('scan-tokens', token as string);
    expect(await lock.acquire('scan-tokens', 60_000)).not.toBeNull();
  });
});
