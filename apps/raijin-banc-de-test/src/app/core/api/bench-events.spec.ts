import { TestBed } from '@angular/core/testing';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BenchApi } from './bench-api';
import { FakeBenchApi, apiError } from './bench-api.testing';
import { BENCH_EVENT_SOURCE, BenchEvents, SSE_RETRY_INITIAL_MS, eventsUrl, parseBenchEvent, type EventSourceLike } from './bench-events';

const MINT = 'So11111111111111111111111111111111111111112';

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** Coupure réseau : le navigateur se reconnecte seul (CONNECTING). */
  drop(): void {
    this.readyState = 0;
    this.onerror?.(new Event('error'));
  }

  /** Refus du serveur (401, 429…) : le navigateur abandonne (CLOSED). */
  refuse(): void {
    this.readyState = 2;
    this.onerror?.(new Event('error'));
  }

  send(type: string, data: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type, { data: typeof data === 'string' ? data : JSON.stringify(data) }));
  }
}

describe('parseBenchEvent', () => {
  it('keeps contract events and drops malformed ones', () => {
    expect(parseBenchEvent(JSON.stringify({ type: 'token.delete', mint: MINT }))).toEqual({ type: 'token.delete', mint: MINT });
    expect(parseBenchEvent(JSON.stringify({ type: 'token.delete', mint: 'pas-un-mint' }))).toBeNull();
    expect(parseBenchEvent('{')).toBeNull();
    expect(parseBenchEvent(JSON.stringify({ type: 'inconnu' }))).toBeNull();
  });

  it('builds /api/events?topics=…', () => {
    expect(eventsUrl(['tokens', 'paper', 'tokens'])).toBe('/api/events?topics=tokens,paper');
  });
});

describe('BenchEvents', () => {
  let sources: FakeSource[];
  let api: FakeBenchApi;

  beforeEach(() => {
    vi.useFakeTimers();
    sources = [];
    api = new FakeBenchApi();
    TestBed.configureTestingModule({
      providers: [
        { provide: BenchApi, useValue: api },
        {
          provide: BENCH_EVENT_SOURCE,
          useValue: (url: string) => {
            const s = new FakeSource(url);
            sources.push(s);
            return s;
          },
        },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  function connect() {
    const onEvent = vi.fn();
    const onReconnect = vi.fn();
    const sub = TestBed.inject(BenchEvents).connect(['paper'], { onEvent, onReconnect });
    return { sub, onEvent, onReconnect };
  }

  it('delivers contract events of the requested topics', () => {
    const { onEvent } = connect();
    expect(sources[0]?.url).toBe('/api/events?topics=paper');
    sources[0]?.open();
    sources[0]?.send('paper.changed', { type: 'paper.changed', book: 'main', position_id: '12' });
    sources[0]?.send('paper.changed', { type: 'paper.changed', book: 'inconnu', position_id: null });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'paper.changed', book: 'main', position_id: '12' });
  });

  it('after a network drop the browser reconnects: the screen reloads its lists (no replay)', () => {
    const { onReconnect } = connect();
    sources[0]?.open();
    expect(onReconnect).not.toHaveBeenCalled();
    sources[0]?.drop();
    sources[0]?.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(1);
  });

  it('when the server refuses the stream: checks the session, then reopens with a growing delay', async () => {
    api.on('GET', BENCH_ROUTES.authSession, () => {
      throw apiError(503);
    });
    const { onReconnect } = connect();
    sources[0]?.open();
    sources[0]?.refuse();
    expect(sources[0]?.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(SSE_RETRY_INITIAL_MS);
    expect(api.callsTo('GET', BENCH_ROUTES.authSession)).toHaveLength(1);
    expect(sources).toHaveLength(1); // API indisponible : nouvel essai plus tard

    api.on('GET', BENCH_ROUTES.authSession, { email: 'me@example.com', mode: 'shadow', expiresAt: '2026-11-24T20:00:00.000Z' });
    await vi.advanceTimersByTimeAsync(SSE_RETRY_INITIAL_MS);
    expect(sources).toHaveLength(1); // délai doublé : 2 s
    await vi.advanceTimersByTimeAsync(SSE_RETRY_INITIAL_MS);
    expect(sources).toHaveLength(2);
    sources[1]?.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('stops retrying on 401 (AuthStore sends the user back to /login)', async () => {
    api.on('GET', BENCH_ROUTES.authSession, () => {
      throw apiError(401, 'AUTH_SESSION_EXPIRED');
    });
    connect();
    sources[0]?.refuse();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.callsTo('GET', BENCH_ROUTES.authSession)).toHaveLength(1);
    expect(sources).toHaveLength(1);
  });

  it('close() closes the stream and cancels a pending reconnection', async () => {
    const { sub, onEvent } = connect();
    sources[0]?.refuse();
    sub.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.calls).toHaveLength(0);
    sources[0]?.send('paper.changed', { type: 'paper.changed', book: 'main', position_id: null });
    expect(onEvent).not.toHaveBeenCalled();
  });
});
