import { UPSTREAM_IDS, UpstreamError, type UpstreamId } from './errors';
import type { SolanaLogger } from './ports';
import { UpstreamGate, type GateOptions } from './upstream-gate';
import {
  CounterUsageRecorder,
  MemoryUsageCounterStore,
  NOOP_USAGE_RECORDER,
  UPSTREAM_USAGE_TTL_S,
  UsageRecordingCreditBudget,
  assertUtcDay,
  classifyUpstreamError,
  upstreamCallsKey,
  upstreamCreditsKey,
  type UsageCounterStore,
} from './usage';

const DAY = '2026-11-22';
const T0 = Date.parse(`${DAY}T10:00:00Z`);

function clockAt(start = T0) {
  const clock = { t: start, now: () => clock.t };
  return clock;
}

function recorderWith(store: UsageCounterStore, clock = clockAt(), logger?: SolanaLogger) {
  return new CounterUsageRecorder(store, UPSTREAM_IDS, clock, logger);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('classifyUpstreamError', () => {
  it.each([
    [new UpstreamError('jupiter', 'timeout'), { kind: 'call', outcome: 'timeout' }],
    [new UpstreamError('jupiter', 'rate_limited', 429), { kind: 'call', outcome: 'rate_limited' }],
    [new UpstreamError('jupiter', 'network'), { kind: 'call', outcome: 'network' }],
    [new UpstreamError('jupiter', 'http_error', 503), { kind: 'call', outcome: 'server_error' }],
    [new UpstreamError('jupiter', 'http_error', 403), { kind: 'call', outcome: 'other' }],
    [new UpstreamError('jupiter', 'http_error'), { kind: 'call', outcome: 'other' }],
    [new UpstreamError('jupiter', 'invalid_response', 200), { kind: 'call', outcome: 'validation' }],
    [new UpstreamError('helius_rpc', 'rpc_error', -32602), { kind: 'call', outcome: 'other' }],
    [new UpstreamError('rugcheck', 'too_large'), { kind: 'call', outcome: 'oversized' }],
    [new UpstreamError('rugcheck', 'aborted'), { kind: 'call', outcome: 'cancelled' }],
    [new UpstreamError('helius_das', 'budget_exhausted'), { kind: 'rejection', reason: 'budget_exhausted' }],
    [new UpstreamError('helius_das', 'circuit_open'), { kind: 'rejection', reason: 'circuit_open' }],
    [new UpstreamError('helius_das', 'queue_full'), { kind: 'rejection', reason: 'queue_full' }],
    [new UpstreamError('helius_das', 'not_configured'), { kind: 'rejection', reason: 'not_configured' }],
  ])('%s', (error, expected) => {
    expect(classifyUpstreamError(error)).toEqual(expected);
  });
});

describe('clés et jours UTC', () => {
  it('clés fermées, jour validé (aucune valeur libre dans une clé)', () => {
    expect(upstreamCallsKey('jupiter', DAY)).toBe('upstream:calls:jupiter:2026-11-22');
    expect(upstreamCreditsKey(DAY)).toBe('upstream:credits:2026-11-22');
    for (const bad of ['2026-02-30', '2026-13-01', '22-11-2026', '2026-11-22:*', '']) {
      expect(() => assertUtcDay(bad)).toThrow(RangeError);
    }
    expect(UPSTREAM_USAGE_TTL_S).toBe(691_200);
  });
});

describe('NOOP_USAGE_RECORDER', () => {
  it('ignore tout', () => {
    expect(NOOP_USAGE_RECORDER.recordCall('jupiter', 'success', 1)).toBeUndefined();
    expect(NOOP_USAGE_RECORDER.recordRejection('jupiter', 'queue_full')).toBeUndefined();
    expect(NOOP_USAGE_RECORDER.recordCredits('watch', 1)).toBeUndefined();
    expect(NOOP_USAGE_RECORDER.recordCreditRefusal('watch')).toBeUndefined();
  });
});

describe('MemoryUsageCounterStore', () => {
  it('cumule, expire et borne le nombre de clés', async () => {
    const clock = clockAt();
    const store = new MemoryUsageCounterStore(clock, 2);
    await store.increment('a', { x: 1 }, 10);
    await store.increment('a', { x: 2, y: 1 }, 10);
    expect(await store.read(['a', 'absent'])).toEqual([{ x: 3, y: 1 }, null]);
    await store.increment('b', { x: 1 }, 10);
    await store.increment('c', { x: 1 }, 10);
    expect((await store.read(['a', 'b', 'c'])).map((h) => h !== null)).toEqual([false, true, true]);
    clock.t += 10_000;
    expect(await store.read(['b'])).toEqual([null]);
    await store.increment('b', { x: 5 }, 10);
    expect(await store.read(['b'])).toEqual([{ x: 5 }]);
  });
});

describe('CounterUsageRecorder', () => {
  it('compte appels, issues, refus, latence et crédits par jour UTC', async () => {
    const clock = clockAt();
    const recorder = recorderWith(new MemoryUsageCounterStore(clock), clock);
    recorder.recordCall('jupiter', 'success', 120.4);
    recorder.recordCall('jupiter', 'timeout', 4_000);
    recorder.recordCall('jupiter', 'success', Number.NaN);
    recorder.recordRejection('jupiter', 'circuit_open');
    recorder.recordCredits('watch', 10);
    recorder.recordCredits('watch', 0);
    recorder.recordCredits('interactive', 1.5);
    recorder.recordCreditRefusal('wallet');
    clock.t += 86_400_000; // lendemain : autre jeu de compteurs
    recorder.recordCall('jupiter', 'success', 1);
    await flush();

    const day = await recorder.read(DAY);
    expect(day.status).toBe('ok');
    const jupiter = day.sources.find((s) => s.source === 'jupiter');
    expect(jupiter?.outcomes).toMatchObject({ success: 2, timeout: 1, validation: 0 });
    expect(jupiter?.rejections).toMatchObject({ circuit_open: 1, queue_full: 0 });
    expect(jupiter?.latencyMsTotal).toBe(4_120);
    expect(day.credits).toEqual({ used: { interactive: 0, watch: 10, wallet: 0 }, refused: { interactive: 0, watch: 0, wallet: 1 } });
    expect((await recorder.read('2026-11-23')).sources.find((s) => s.source === 'jupiter')?.outcomes.success).toBe(1);
    await expect(recorder.read('2026-11-22; DROP')).rejects.toThrow(RangeError);
  });

  it('valeurs hostiles du stockage ramenées à 0 ; chaînes Redis lues', async () => {
    const store: UsageCounterStore = {
      increment: async () => undefined,
      read: async (keys) =>
        keys.map((key): Record<string, string | number> =>
          key.startsWith('upstream:calls:jupiter')
            ? { success: '7', timeout: '-3', network: 'abc', other: 1e20, validation: 2.5, latency_ms: '700' }
            : key.startsWith('upstream:credits')
              ? { used_watch: '42' }
              : {},
        ),
    };
    const day = await recorderWith(store).read(DAY);
    expect(day.sources.find((s) => s.source === 'jupiter')).toMatchObject({
      outcomes: { success: 7, timeout: 0, network: 0, other: 0, validation: 0 },
      latencyMsTotal: 700,
    });
    expect(day.credits.used.watch).toBe(42);
  });

  it('stockage en panne : aucune exception, lecture « unavailable », avertissement limité à 1/min sans détail', async () => {
    const warn = jest.fn();
    const logger: SolanaLogger = { debug: () => undefined, warn };
    const clock = clockAt();
    const failing: UsageCounterStore = {
      increment: () => Promise.reject(new Error('redis://user:secret@host')),
      read: () => Promise.reject(new Error('down')),
    };
    const recorder = recorderWith(failing, clock, logger);
    expect(() => recorder.recordCall('rugcheck', 'success', 1)).not.toThrow();
    recorder.recordCall('rugcheck', 'success', 1);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('upstream_usage_write_failed', {});

    clock.t += 61_000;
    const day = await recorder.read(DAY);
    expect(day.status).toBe('unavailable');
    expect(day.sources.every((s) => s.outcomes.success === 0)).toBe(true);
    expect(warn).toHaveBeenLastCalledWith('upstream_usage_read_failed', {});

    const throwing: UsageCounterStore = {
      increment: () => {
        throw new Error('sync');
      },
      read: async () => [],
    };
    clock.t += 61_000;
    expect(() => recorderWith(throwing, clock, logger).recordRejection('jupiter', 'queue_full')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('UsageRecordingCreditBudget', () => {
  it('enregistre les crédits acceptés par voie et les refus', async () => {
    const recorder = { recordCall: jest.fn(), recordRejection: jest.fn(), recordCredits: jest.fn(), recordCreditRefusal: jest.fn() };
    let allow = true;
    const budget = new UsageRecordingCreditBudget({ tryConsume: async () => allow }, recorder);
    await expect(budget.tryConsume(10, 'wallet')).resolves.toBe(true);
    allow = false;
    await expect(budget.tryConsume(1, 'watch')).resolves.toBe(false);
    expect(recorder.recordCredits).toHaveBeenCalledWith('wallet', 10);
    expect(recorder.recordCreditRefusal).toHaveBeenCalledWith('watch');
  });
});

describe('UpstreamGate + enregistreur', () => {
  beforeEach(() => jest.useFakeTimers({ now: T0 }));
  afterEach(() => jest.useRealTimers());

  const base: GateOptions = {
    source: 'jupiter',
    ratePerSecond: 100,
    maxQueue: 1,
    maxAttempts: 2,
    backoffBaseMs: 10,
    maxRetryAfterMs: 100,
    breakerThreshold: 1,
    breakerCooldownMs: 30_000,
  };

  function setup(options: Partial<GateOptions> = {}) {
    const calls: Array<[UpstreamId, string, number]> = [];
    const rejections: Array<[UpstreamId, string]> = [];
    const recorder = {
      recordCall: (source: UpstreamId, outcome: string, latency: number) => calls.push([source, outcome, latency]),
      recordRejection: (source: UpstreamId, reason: string) => rejections.push([source, reason]),
      recordCredits: () => undefined,
      recordCreditRefusal: () => undefined,
    };
    const gate = new UpstreamGate({ ...base, ...options }, { random: () => 0, usage: recorder });
    return { gate, calls, rejections };
  }

  it('chaque tentative est comptée (rejeu compris) avec sa latence ; puis disjoncteur ouvert → refus', async () => {
    const { gate, calls, rejections } = setup();
    const task = jest
      .fn()
      .mockImplementationOnce(async () => {
        jest.setSystemTime(Date.now() + 250);
        throw new UpstreamError('jupiter', 'timeout');
      })
      .mockRejectedValueOnce(new UpstreamError('jupiter', 'http_error', 502));
    const promise = gate.run(task);
    const assertion = expect(promise).rejects.toMatchObject({ kind: 'http_error' });
    await jest.advanceTimersByTimeAsync(20);
    await assertion;
    expect(calls).toEqual([
      ['jupiter', 'timeout', 250],
      ['jupiter', 'server_error', 0],
    ]);
    await expect(gate.run(async () => 1)).rejects.toMatchObject({ kind: 'circuit_open' });
    expect(rejections).toEqual([['jupiter', 'circuit_open']]);
  });

  it('succès compté ; budget épuisé dans la tâche = refus, pas un appel', async () => {
    const { gate, calls, rejections } = setup();
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
    await expect(gate.run(() => Promise.reject(new UpstreamError('jupiter', 'budget_exhausted')))).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(calls).toEqual([['jupiter', 'success', 0]]);
    expect(rejections).toEqual([['jupiter', 'budget_exhausted']]);
  });

  it('file pleine et annulation en file : refus sans appel', async () => {
    const { gate, calls, rejections } = setup({ ratePerSecond: 1, burst: 1 });
    void gate.run(async () => 1);
    const controller = new AbortController();
    const queued = gate.run(async () => 2, controller.signal);
    await expect(gate.run(async () => 3)).rejects.toMatchObject({ kind: 'queue_full' });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ kind: 'aborted' });
    await jest.advanceTimersByTimeAsync(0);
    expect(rejections).toEqual([
      ['jupiter', 'queue_full'],
      ['jupiter', 'aborted'],
    ]);
    expect(calls).toEqual([['jupiter', 'success', 0]]);
  });
});
