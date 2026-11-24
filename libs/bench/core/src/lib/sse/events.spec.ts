import { BENCH_SSE_HEARTBEAT_SECONDS } from '@raijin/bench-contracts';
import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { cookiesOf, createTestBench, ORIGIN, OWNER_EMAIL, OWNER_PASSWORD, type TestBench } from '../../testing/test-app';
import { BenchEventBus } from './event-bus';
import { formatSse as format } from './events.controller';

const MINT = 'So11111111111111111111111111111111111111112';

describe('SSE du banc', () => {
  let bench: TestBench;
  let port: number;

  beforeEach(async () => {
    bench = await createTestBench();
    await bench.app.listen(0, '127.0.0.1');
    port = (bench.app.getHttpServer().address() as AddressInfo).port;
  });

  afterEach(async () => {
    jest.useRealTimers();
    await bench.app.close();
  });

  async function sessionCookie(): Promise<string> {
    const res = await request(bench.app.getHttpServer()).post('/api/auth/login').set('Origin', ORIGIN).send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp: bench.totp() }).expect(200);
    return Object.entries(cookiesOf(res.headers)).map(([name, value]) => `${name}=${value}`).join('; ');
  }

  function open(path: string, cookie: string): Promise<{ res: IncomingMessage; chunks: string[]; next: () => Promise<string> }> {
    return new Promise((resolve, reject) => {
      const req = get({ host: '127.0.0.1', port, path, headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
        const chunks: string[] = [];
        const waiters: ((chunk: string) => void)[] = [];
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          chunks.push(chunk);
          waiters.shift()?.(chunk);
        });
        res.on('end', () => waiters.splice(0).forEach((done) => done('<fin>')));
        resolve({ res, chunks, next: () => new Promise((done) => waiters.push(done)) });
      });
      req.on('error', reject);
    });
  }

  it('401 sans session', async () => {
    const { res } = await open('/api/events', '');
    expect(res.statusCode).toBe(401);
    res.destroy();
  });

  it('flux authentifié : en-têtes SSE, battement initial, filtrage par famille (tokens, paper)', async () => {
    const cookie = await sessionCookie();
    const stream = await open('/api/events?topics=tokens', cookie);
    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(stream.res.headers['x-accel-buffering']).toBe('no');
    expect(stream.res.headers['cache-control']).toBe('no-cache, no-transform');
    while (!stream.chunks.join('').includes('event: heartbeat')) await stream.next();
    expect(stream.chunks.join('')).toContain('retry: 5000');

    const bus = bench.app.get(BenchEventBus);
    bus.publish({ type: 'paper.changed', book: 'manual', position_id: null } as never);
    bus.publish({ type: 'token.delete', mint: MINT });
    while (!stream.chunks.join('').includes('token.delete')) await stream.next();
    const text = stream.chunks.join('');
    expect(text).toContain(`event: token.delete\ndata: {"type":"token.delete","mint":"${MINT}"}\n\n`);
    expect(text).not.toContain('paper.changed');
    stream.res.destroy();
  });

  it('familles inconnues refusées (400)', async () => {
    const cookie = await sessionCookie();
    const { res } = await open('/api/events?topics=secrets', cookie);
    expect(res.statusCode).toBe(400);
    res.destroy();
  });

  it('le flux se ferme quand la session expire (revalidée au battement)', async () => {
    const cookie = await sessionCookie();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const stream = await open('/api/events', cookie);
    while (!stream.chunks.join('').includes('heartbeat')) await stream.next();
    bench.clock.advance(13 * 3600_000);
    const ended = new Promise<void>((resolve) => stream.res.on('end', () => resolve()));
    jest.advanceTimersByTime(BENCH_SSE_HEARTBEAT_SECONDS * 1000);
    jest.useRealTimers();
    await ended;
  });

  it('bus : événement non conforme écarté, format SSE', () => {
    const bus = new BenchEventBus();
    const seen: unknown[] = [];
    bus.events().subscribe((event) => seen.push(event));
    bus.publish({ type: 'token.delete', mint: 'pas-une-adresse' });
    bus.publish({ type: 'heartbeat', at: '2026-11-24T10:00:00.000Z' });
    expect(seen).toHaveLength(1);
    expect(format({ type: 'heartbeat', at: '2026-11-24T10:00:00.000Z' })).toBe('event: heartbeat\ndata: {"type":"heartbeat","at":"2026-11-24T10:00:00.000Z"}\n\n');
    bus.onModuleDestroy();
  });
});
