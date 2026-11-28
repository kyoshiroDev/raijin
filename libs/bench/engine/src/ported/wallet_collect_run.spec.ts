// feat/wallet-study: one wallet-study-collect call against an in-memory store and a mocked history source
// (security review L1 lease token, L2 failure policy / refunds; revoked key leaves the queue untouched).
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test` (zod shim below).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupZodForNode } from './test-support/zod-node';
import type { EarlyBuyerRow, HistoryPage } from './wallet-collect';
import type { CollectStore, QueueRow, StatePatch, StateRow } from './wallet-collect-run';

const zodReady = setupZodForNode();
const W = require('./wallet-collect') as typeof import('./wallet-collect');
const H = require('./wallet-collect-helius') as typeof import('./wallet-collect-helius');
const R = require('./wallet-collect-run') as typeof import('./wallet-collect-run');

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const MINT2 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PAIR2 = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
const SOL = 'So11111111111111111111111111111111111111112';
const FAKE_KEY = '0123abcd-4567-89ef-0123-456789abcdef';
const sig = (n: number) => ('5' + String(n).replace(/0/g, 'z')).padEnd(88, 'A');
const wallet = (n: number) => ('W' + String(n).replace(/0/g, 'o')).padEnd(44, 'x');

/** In-memory twin of the Postgres objects (same cap / lease / refund semantics as the migration). */
class MemStore implements CollectStore {
  credits = 0;
  cap = 600_000;
  leaseUntil = 0;
  leaseToken: string | null = null;
  clock = 0;
  tokens = 0;
  queueRows: QueueRow[] = [];
  states = new Map<string, StateRow & { credits_used: number; error: string | null }>();
  buyers: EarlyBuyerRow[] = [];
  failOn: string | null = null;
  private maybeFail(op: string) {
    if (this.failOn === op) throw new Error(`${op}: connection refused`);
  }
  async claim(s: number) {
    this.maybeFail('claim');
    if (this.leaseToken !== null && this.leaseUntil >= this.clock) return null;
    this.leaseToken = `tok-${++this.tokens}`;
    this.leaseUntil = this.clock + s * 1000;
    return this.leaseToken;
  }
  async release(t: string) {
    if (this.leaseToken === t) {
      this.leaseToken = null;
      this.leaseUntil = 0;
    }
  }
  async queue(limit: number) {
    this.maybeFail('queue');
    const pending = [...this.states.entries()].filter(([, s]) => s.status === 'pending').map(([m]) => m);
    const inProgress = this.queueRows.filter((q) => pending.includes(q.mint)).map((q) => ({ ...q, is_new: false }));
    const fresh = this.queueRows.filter((q) => !this.states.has(q.mint)).map((q) => ({ ...q, is_new: true }));
    return [...inProgress, ...fresh].slice(0, limit);
  }
  async ensureState(q: QueueRow) {
    if (!this.states.has(q.mint)) {
      this.states.set(q.mint, {
        status: 'pending', cursor: null, pages: 0, buyers: 0, creator: null, creator_checked: false,
        pool_creator: null, attempts: 0, dropped_txs: 0, credits_used: 0, error: null,
      });
    }
  }
  async readState(m: string) {
    const s = this.states.get(m);
    return s ? { ...s } : null;
  }
  async reserve(m: string, c: number) {
    this.maybeFail('reserve');
    if (this.credits + c > this.cap) return false;
    this.credits += c;
    const s = this.states.get(m);
    if (s) s.credits_used += c;
    return true;
  }
  async refund(m: string, c: number) {
    this.credits = Math.max(0, this.credits - c);
    const s = this.states.get(m);
    if (s) s.credits_used = Math.max(0, s.credits_used - c);
  }
  async updateState(m: string, p: StatePatch) {
    this.maybeFail('updateState');
    const s = this.states.get(m);
    if (s) Object.assign(s, p);
  }
  async knownBuyers(m: string) {
    return this.buyers.filter((b) => b.mint === m).map((b) => b.wallet);
  }
  async writeBuyers(rows: EarlyBuyerRow[]) {
    this.maybeFail('writeBuyers');
    for (const r of rows) if (!this.buyers.some((b) => b.mint === r.mint && b.wallet === r.wallet)) this.buyers.push(r);
  }
  async budgetUsed() {
    return this.credits;
  }
}

function buyTx(payer: string, slot: number) {
  return {
    slot,
    transactionIndex: 0,
    blockTime: 1_763_700_000 + slot,
    transaction: { signatures: [sig(slot)], message: { accountKeys: [payer] } },
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 2, mint: SOL, owner: PAIR, uiTokenAmount: { amount: '1000000000' } }],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: payer, uiTokenAmount: { amount: '10' } },
        { accountIndex: 2, mint: SOL, owner: PAIR, uiTokenAmount: { amount: '1100000000' } },
      ],
    },
  };
}

/** First transaction of a pool: its fee payer is the pool creator (excluded from the buyers). */
const poolCreation = (slot = 2) => buyTx(wallet(77), slot);

function page(txs: unknown[], next: string | null): HistoryPage {
  return W!.parseHistoryResponse({ jsonrpc: '2.0', id: 1, result: { data: txs, paginationToken: next } });
}

const queueRow = (mint: string, pair: string): QueueRow => ({
  mint, pair_address: pair, pair_created_at: null, detected_at: '2026-11-20T00:00:00Z', is_new: true,
});

const noSleep = () => Promise.resolve();

describe('wallet-collect-run', { skip: zodReady ? false : 'zod not found' }, () => {
  const w = W!;
  const r = R!;

  describe('failurePolicy (L2)', () => {
    it('outage and 429 stop the call without an attempt; per-mint errors count one', () => {
      const out = w.failurePolicy(new w.HistoryError('HTTP 401', 'outage'));
      assert.deepEqual(out, { stopCall: true, countAttempt: false, refund: true });
      assert.deepEqual(w.failurePolicy(new w.HistoryError('HTTP 429', 'rate_limited')), { stopCall: true, countAttempt: false, refund: true });
      assert.deepEqual(w.failurePolicy(new Error('db down')), { stopCall: true, countAttempt: false, refund: false });
      assert.deepEqual(w.failurePolicy(new w.HistoryError('RPC error -32602', 'rpc')), { stopCall: false, countAttempt: true, refund: true });
      assert.deepEqual(w.failurePolicy(new w.HistoryError('invalid RPC envelope')), { stopCall: false, countAttempt: true, refund: false });
    });

    it('HTTP status classes', () => {
      for (const s of [401, 403, 500, 502, 503]) assert.equal(w.httpFailureKind(s), 'outage', String(s));
      assert.equal(w.httpFailureKind(429), 'rate_limited');
      assert.equal(w.httpFailureKind(400), 'mint');
    });
  });

  describe('runCollectCall', () => {
    it('collects buyers and finishes a mint (happy path)', async () => {
      const store = new MemStore();
      store.queueRows = [queueRow(MINT, PAIR)];
      const calls: string[] = [];
      const source = {
        page: async (address: string, cursor: string | null) => {
          calls.push(`${address}:${cursor}`);
          if (address === MINT) return page([buyTx(wallet(99), 1)], '1:0');
          return page([poolCreation(), buyTx(wallet(1), 5), buyTx(wallet(2), 6), buyTx(wallet(99), 7)], null);
        },
      };
      const stats = await r.runCollectCall({ store, source, secret: FAKE_KEY, sleep: noSleep });
      assert.equal(stats.stopped, null);
      assert.deepEqual(calls, [`${MINT}:null`, `${PAIR}:null`]);
      assert.equal(stats.credits, 20);
      assert.equal(store.credits, 20);
      const st = store.states.get(MINT)!;
      assert.equal(st.status, 'exhausted');
      assert.equal(st.creator, wallet(99));
      assert.deepEqual(store.buyers.map((b) => [b.wallet, b.rank]), [[wallet(1), 1], [wallet(2), 2]]);
      assert.equal(store.leaseToken, null, 'lease released');
    });

    it('revoked key (HTTP 401): call stopped, queue untouched, no attempt, reservation refunded, key never echoed', async () => {
      const store = new MemStore();
      store.queueRows = [queueRow(MINT, PAIR), queueRow(MINT2, PAIR2)];
      const fetchFn = () => Promise.resolve(new Response(`{"error":"invalid api key ${FAKE_KEY}"}`, { status: 401 }));
      const source = H!.createHeliusSource(FAKE_KEY, fetchFn);
      const stats = await r.runCollectCall({ store, source, secret: FAKE_KEY, sleep: noSleep });
      assert.equal(stats.stopped, 'outage');
      assert.equal(stats.mints, 1, 'the second mint is not touched');
      assert.ok(!store.states.has(MINT2));
      const st = store.states.get(MINT)!;
      assert.equal(st.attempts, 0);
      assert.equal(st.status, 'pending');
      assert.equal(st.error, null);
      assert.equal(st.credits_used, 0);
      assert.equal(store.credits, 0, 'budget unchanged');
      assert.equal(stats.refunded, 10);
      assert.equal(stats.credits, 0);
      assert.ok(!JSON.stringify(stats).includes(FAKE_KEY));
      assert.equal(store.leaseToken, null);
      // Every following call does the same until the key is fixed: attempts never reach 'failed'.
      for (let i = 0; i < 5; i++) await r.runCollectCall({ store, source, secret: FAKE_KEY, sleep: noSleep });
      assert.equal(store.states.get(MINT)!.attempts, 0);
      assert.equal(store.credits, 0);
    });

    it('network failure and 5xx: outage, refunded; 429: rate_limited, refunded, no attempt', async () => {
      for (const [answer, reason] of [
        [() => Promise.reject(new TypeError(`error sending request for url (https://x/?api-key=${FAKE_KEY})`)), 'outage'],
        [() => Promise.resolve(new Response('', { status: 503 })), 'outage'],
        [() => Promise.resolve(new Response('', { status: 429 })), 'rate_limited'],
      ] as const) {
        const store = new MemStore();
        store.queueRows = [queueRow(MINT, PAIR)];
        const stats = await r.runCollectCall({
          store, source: H!.createHeliusSource(FAKE_KEY, answer), secret: FAKE_KEY, sleep: noSleep,
        });
        assert.equal(stats.stopped, reason);
        assert.equal(store.credits, 0);
        assert.equal(store.states.get(MINT)!.attempts, 0);
        assert.ok(!JSON.stringify(stats).includes(FAKE_KEY));
      }
    });

    it('DB error inside a request: outage, no attempt; the already-metered page stays counted', async () => {
      const store = new MemStore();
      store.queueRows = [queueRow(MINT, PAIR)];
      const source = {
        page: async (address: string) => (address === MINT ? page([], null) : page([poolCreation(), buyTx(wallet(1), 5)], '5:0')),
      };
      store.failOn = 'writeBuyers';
      const stats = await r.runCollectCall({ store, source, secret: FAKE_KEY, sleep: noSleep });
      assert.equal(stats.stopped, 'outage');
      assert.match(stats.error ?? '', /writeBuyers/);
      assert.equal(store.states.get(MINT)!.attempts, 0);
      assert.equal(store.credits, 20, 'two successful (metered) responses: no refund');
    });

    it('per-mint error (bad envelope): attempt counted, next mint processed; failed after 3', async () => {
      const store = new MemStore();
      store.queueRows = [queueRow(MINT, PAIR), queueRow(MINT2, PAIR2)];
      const source = {
        page: async (address: string) => {
          if (address === MINT || address === PAIR) throw new w.HistoryError('invalid RPC envelope', 'mint');
          return page([], null);
        },
      };
      const stats = await r.runCollectCall({ store, source, secret: FAKE_KEY, sleep: noSleep });
      assert.equal(stats.stopped, null);
      assert.equal(store.states.get(MINT)!.attempts, 1);
      assert.equal(store.states.get(MINT2)!.status, 'exhausted');
      assert.equal(store.credits, 10 + 20, 'bad 2xx stays counted');
      await r.runCollectCall({ store, source, secret: FAKE_KEY, sleep: noSleep });
      await r.runCollectCall({ store, source, secret: FAKE_KEY, sleep: noSleep });
      assert.equal(store.states.get(MINT)!.status, 'failed');
    });

    it('hard cap: no request once the budget is spent', async () => {
      const store = new MemStore();
      store.credits = 599_995;
      store.queueRows = [queueRow(MINT, PAIR)];
      let called = 0;
      const stats = await r.runCollectCall({
        store, source: { page: async () => { called++; return page([], null); } }, secret: FAKE_KEY, sleep: noSleep,
      });
      assert.equal(stats.stopped, 'budget');
      assert.equal(called, 0);
      assert.equal(store.credits, 599_995);
    });
  });

  describe('lease (L1)', () => {
    it('busy while held; a stale token cannot release the current lease', async () => {
      const store = new MemStore();
      const t1 = await store.claim(r.LEASE_S);
      assert.ok(t1);
      const busy = await r.runCollectCall({ store, source: { page: async () => page([], null) }, secret: FAKE_KEY });
      assert.equal(busy.skipped, 'busy');
      assert.equal(store.leaseToken, t1, 'the busy call did not release the lease');
      // Lease expires, a new call takes it; the late owner of t1 releases: no effect.
      store.clock += r.LEASE_S * 1000 + 1;
      const t2 = await store.claim(r.LEASE_S);
      assert.ok(t2 && t2 !== t1);
      await store.release(t1!);
      assert.equal(store.leaseToken, t2);
    });

    it('the worst-case call stays well under the lease', () => {
      assert.ok(r.STOP_NEW_REQUEST_MS + H!.HISTORY_TIMEOUT_MS + 15_000 < r.LEASE_S * 1000);
      assert.ok(r.STOP_NEW_REQUEST_MS + H!.HISTORY_TIMEOUT_MS < 55_000, 'and under the pg_net timeout');
    });

    it('stops starting requests after STOP_NEW_REQUEST_MS', async () => {
      const store = new MemStore();
      store.queueRows = [queueRow(MINT, PAIR)];
      let t = 0;
      const source = { page: async () => { t += 16_000; return page([buyTx(wallet(t), t)], `${t}:0`); } };
      const stats = await r.runCollectCall({ store, source, secret: FAKE_KEY, sleep: noSleep, now: () => t });
      assert.equal(stats.stopped, 'time');
      assert.equal(stats.pages + 1, 2, 'creator lookup + 1 page, then stop');
      assert.equal(store.states.get(MINT)!.attempts, 0);
      assert.equal(store.leaseToken, null);
    });
  });
});
