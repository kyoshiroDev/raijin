import { UpstreamError } from './errors';
import { UpstreamGate, type GateOptions } from './upstream-gate';

const base: GateOptions = {
  source: 'dexscreener',
  ratePerSecond: 2,
  maxQueue: 3,
  maxAttempts: 2,
  backoffBaseMs: 100,
  maxRetryAfterMs: 2_000,
  breakerThreshold: 3,
  breakerCooldownMs: 30_000,
};

describe('UpstreamGate', () => {
  beforeEach(() => jest.useFakeTimers({ now: Date.parse('2026-11-22T00:00:00Z') }));
  afterEach(() => jest.useRealTimers());

  const gate = (options: Partial<GateOptions> = {}) => new UpstreamGate({ ...base, ...options }, { random: () => 0.5 });

  it('refuse un débit nul', () => {
    expect(() => new UpstreamGate({ ...base, ratePerSecond: 0 })).toThrow(RangeError);
  });

  it('seau à jetons : rafale puis 2 req/s, ordre FIFO', async () => {
    const g = gate();
    const done: number[] = [];
    const start = Date.now();
    const runs = [0, 1, 2, 3].map((i) => g.run(async () => done.push(i) && Date.now() - start));
    await jest.advanceTimersByTimeAsync(0);
    expect(done).toEqual([0, 1]);
    await jest.advanceTimersByTimeAsync(500);
    expect(done).toEqual([0, 1, 2]);
    await jest.advanceTimersByTimeAsync(500);
    expect(done).toEqual([0, 1, 2, 3]);
    await expect(Promise.all(runs)).resolves.toHaveLength(4);
  });

  it('débit fractionnaire (0,5 req/s) : un appel toutes les 2 s', async () => {
    const g = gate({ ratePerSecond: 0.5, maxQueue: 5 });
    const done: number[] = [];
    void g.run(async () => done.push(1));
    void g.run(async () => done.push(2));
    await jest.advanceTimersByTimeAsync(1_999);
    expect(done).toEqual([1]);
    await jest.advanceTimersByTimeAsync(1);
    expect(done).toEqual([1, 2]);
  });

  it('file pleine → échec immédiat queue_full', async () => {
    const g = gate({ ratePerSecond: 1, maxQueue: 1 });
    void g.run(async () => 1);
    void g.run(async () => 2);
    await expect(g.run(async () => 3)).rejects.toMatchObject({ kind: 'queue_full' });
  });

  it('annulation pendant l’attente → aborted et retrait de la file', async () => {
    const g = gate({ ratePerSecond: 1, maxQueue: 2 });
    void g.run(async () => 1);
    const controller = new AbortController();
    const waiting = g.run(async () => 2, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ kind: 'aborted' });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(g.run(async () => 3, preAborted.signal)).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('rejeu après erreur réseau avec backoff + gigue, puis succès', async () => {
    const g = gate({ ratePerSecond: 100 });
    const task = jest.fn().mockRejectedValueOnce(new UpstreamError('dexscreener', 'network')).mockResolvedValueOnce('ok');
    const promise = g.run(task);
    await jest.advanceTimersByTimeAsync(149);
    expect(task).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('429 : Retry-After respecté, plafonné', async () => {
    const g = gate({ ratePerSecond: 100, maxRetryAfterMs: 1_000 });
    const task = jest.fn().mockRejectedValueOnce(new UpstreamError('dexscreener', 'rate_limited', 429, 5_000)).mockResolvedValueOnce('ok');
    const promise = g.run(task);
    await jest.advanceTimersByTimeAsync(999);
    expect(task).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe('ok');
  });

  it('erreur non rejouable (400) : un seul essai, ne compte pas pour le disjoncteur', async () => {
    const g = gate({ ratePerSecond: 100, breakerThreshold: 1 });
    const task = jest.fn().mockRejectedValue(new UpstreamError('dexscreener', 'http_error', 400));
    await expect(g.run(task)).rejects.toMatchObject({ kind: 'http_error' });
    expect(task).toHaveBeenCalledTimes(1);
    expect(g.breakerState).toBe('closed');
  });

  it('erreur inconnue réemballée en network, sans cause', async () => {
    const g = gate({ ratePerSecond: 100, maxAttempts: 1 });
    const error = await g.run(async () => Promise.reject(new Error('https://secret-url'))).catch((e: unknown) => e as UpstreamError);
    expect(error).toMatchObject({ kind: 'network', source: 'dexscreener' });
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain('secret-url');
  });

  it('annulation pendant le backoff → aborted', async () => {
    const g = gate({ ratePerSecond: 100 });
    const controller = new AbortController();
    const promise = g.run(() => Promise.reject(new UpstreamError('dexscreener', 'timeout')), controller.signal);
    await jest.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('disjoncteur : ouvert après N échecs, un essai après refroidissement, refermé sur succès', async () => {
    const g = gate({ ratePerSecond: 100, maxAttempts: 1 });
    const failing = () => Promise.reject(new UpstreamError('dexscreener', 'http_error', 502));
    for (let i = 0; i < 3; i += 1) await expect(g.run(failing)).rejects.toMatchObject({ kind: 'http_error' });
    expect(g.breakerState).toBe('open');
    await expect(g.run(async () => 'x')).rejects.toMatchObject({ kind: 'circuit_open' });

    await jest.advanceTimersByTimeAsync(30_000);
    expect(g.breakerState).toBe('half_open');
    let release: (value: string) => void = () => undefined;
    const trial = g.run(() => new Promise<string>((resolve) => (release = resolve)));
    await expect(g.run(async () => 'concurrent')).rejects.toMatchObject({ kind: 'circuit_open' });
    release('ok');
    await expect(trial).resolves.toBe('ok');
    expect(g.breakerState).toBe('closed');
  });

  it('disjoncteur : essai en échec → rouvert', async () => {
    const g = gate({ ratePerSecond: 100, maxAttempts: 1, breakerThreshold: 1 });
    const failing = () => Promise.reject(new UpstreamError('dexscreener', 'timeout'));
    await expect(g.run(failing)).rejects.toMatchObject({ kind: 'timeout' });
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(g.run(failing)).rejects.toMatchObject({ kind: 'timeout' });
    expect(g.breakerState).toBe('open');
  });
});
