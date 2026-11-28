// feat/wallet-study: wallet-study-collect pure helpers (GTFA parsing, buyer extraction / dedupe / rank, exclusions,
// credit budget, secret redaction) and the Helius source with a mocked fetch (no network).
// Runs with `deno test supabase/functions` and `node --experimental-strip-types --test` (zod shim below).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupZodForNode } from './test-support/zod-node.ts';

const zodReady = await setupZodForNode();
const W = zodReady ? await import('./wallet-collect.ts') : null;
const H = zodReady ? await import('./wallet-collect-helius.ts') : null;

const MINT = 'D9EcoQZeAytCrF1kQFSpRNpoPhibJUvJcmRHXhubpump';
const PAIR = 'B8a1mw1vfm5pnm4RgUd8zhbtBnkPB2fBMdikU33Z1jqv';
const VAULT_OWNER = PAIR; // PumpSwap: the pool owns its vaults
const SOL = 'So11111111111111111111111111111111111111112';
const BUYER_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BUYER_B = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
const CREATOR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const FAKE_KEY = '0123abcd-4567-89ef-0123-456789abcdef';

/** base58 signature (88 chars) derived from a number. */
const sig = (n: number) => ('5' + String(n).replace(/0/g, 'z')).padEnd(88, 'A');
/** a fake but valid base58 wallet from a number (44 chars). */
const wallet = (n: number) => ('W' + String(n).replace(/0/g, 'o')).padEnd(44, 'x');

interface TxOpts {
  payer: string;
  slot: number;
  index?: number;
  tokenPre?: string;
  tokenPost: string;
  solToPool?: bigint; // lamports
  err?: unknown;
  blockTime?: number;
}

/** A GTFA full transaction (json encoding) for a swap on PAIR: payer's MINT account + the pool's WSOL vault. */
function tx(o: TxOpts, n = o.slot): unknown {
  const pre = [
    { accountIndex: 1, mint: MINT, owner: o.payer, uiTokenAmount: { amount: o.tokenPre ?? '0', decimals: 6 } },
    { accountIndex: 2, mint: SOL, owner: VAULT_OWNER, uiTokenAmount: { amount: '100000000000', decimals: 9 } },
  ];
  if (o.tokenPre === undefined) pre.shift(); // account created in the transaction: no pre balance
  return {
    slot: o.slot,
    transactionIndex: o.index ?? 0,
    blockTime: o.blockTime ?? 1_763_700_000 + o.slot,
    transaction: { signatures: [sig(n)], message: { accountKeys: [o.payer, 'Acct1111111111111111111111111111', PAIR] } },
    meta: {
      err: o.err ?? null,
      fee: 5000,
      preTokenBalances: pre,
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: o.payer, uiTokenAmount: { amount: o.tokenPost, decimals: 6 } },
        {
          accountIndex: 2,
          mint: SOL,
          owner: VAULT_OWNER,
          uiTokenAmount: { amount: String(100_000_000_000n + (o.solToPool ?? 0n)), decimals: 9 },
        },
      ],
    },
  };
}

const envelope = (data: unknown[], paginationToken: string | null = null) => ({
  jsonrpc: '2.0',
  id: 1,
  result: { data, paginationToken },
});

describe('wallet-collect', { skip: zodReady ? false : 'zod not found' }, () => {
  const w = W!;

  describe('parseHistoryResponse / parseTx', () => {
    it('parses a page, keeps chain order, exposes the cursor', () => {
      const page = w.parseHistoryResponse(envelope([
        tx({ payer: BUYER_B, slot: 12, tokenPost: '5', solToPool: 2_000_000_000n }),
        tx({ payer: BUYER_A, slot: 10, tokenPost: '7', solToPool: 500_000_000n }),
      ], '12:3'));
      assert.equal(page.returned, 2);
      assert.equal(page.dropped, 0);
      assert.equal(page.next, '12:3');
      assert.deepEqual(page.txs.map((t) => t.feePayer), [BUYER_A, BUYER_B]);
      assert.equal(page.txs[0].blockTime, 1_763_700_010);
    });

    it('drops failed / malformed transactions one by one, never the page', () => {
      const bad = { slot: 'x' };
      const badPayer = tx({ payer: 'not-base58-0OIl', slot: 3, tokenPost: '1' });
      const page = w.parseHistoryResponse(envelope([
        tx({ payer: BUYER_A, slot: 1, tokenPost: '1', err: { InstructionError: [0, 'Custom'] } }),
        bad,
        badPayer,
        tx({ payer: BUYER_B, slot: 4, tokenPost: '1' }),
      ]));
      assert.equal(page.returned, 4);
      assert.equal(page.dropped, 3);
      assert.deepEqual(page.txs.map((t) => t.feePayer), [BUYER_B]);
      assert.equal(page.next, null);
    });

    it('accepts jsonParsed account keys ({ pubkey })', () => {
      const raw = tx({ payer: BUYER_A, slot: 1, tokenPost: '1' }) as {
        transaction: { message: { accountKeys: unknown[] } };
      };
      raw.transaction.message.accountKeys = raw.transaction.message.accountKeys.map((k) => ({ pubkey: k, signer: true }));
      assert.equal(w.parseTx(raw)?.feePayer, BUYER_A);
    });

    it('rejects an invalid pagination token and RPC errors (429 flagged)', () => {
      assert.equal(w.parseHistoryResponse(envelope([], 'abc; drop')).next, null);
      assert.throws(() => w.parseHistoryResponse({ error: { code: -32602, message: 'bad' } }), /RPC error -32602/);
      try {
        w.parseHistoryResponse({ error: { code: 429, message: 'slow down' } });
        assert.fail('should throw');
      } catch (e) {
        assert.ok(e instanceof w.HistoryError && e.rateLimited);
      }
      assert.throws(() => w.parseHistoryResponse('nope'), /invalid RPC envelope/);
      assert.throws(() => w.parseHistoryResponse({ jsonrpc: '2.0' }), /without result/);
    });
  });

  describe('extractBuy', () => {
    it('a buy = payer token balance up; SOL = WSOL received by the other side', () => {
      const t = w.parseTx(tx({ payer: BUYER_A, slot: 1, tokenPost: '1000', solToPool: 1_250_000_000n }))!;
      const b = w.extractBuy(t, MINT)!;
      assert.equal(b.wallet, BUYER_A);
      assert.equal(b.sol, 1.25);
      assert.equal(b.slot, 1);
    });

    it('a sell (balance down) or a non-SOL quote', () => {
      const sell = w.parseTx(tx({ payer: BUYER_A, slot: 1, tokenPre: '1000', tokenPost: '10' }))!;
      assert.equal(w.extractBuy(sell, MINT), null);
      const noSol = w.parseTx(tx({ payer: BUYER_A, slot: 1, tokenPost: '10' }))!;
      assert.equal(w.extractBuy(noSol, MINT)?.sol, null);
    });

    it('ignores WSOL received by the buyer itself and other mints', () => {
      const t = w.parseTx(tx({ payer: BUYER_A, slot: 1, tokenPost: '10', solToPool: 1_000_000_000n }))!;
      t.tokenDeltas.push({ accountIndex: 9, mint: SOL, owner: BUYER_A, pre: 0n, post: 5_000_000_000n });
      assert.equal(w.extractBuy(t, MINT)?.sol, 1);
      assert.equal(w.extractBuy(t, BUYER_B), null);
    });
  });

  describe('collectBuyers', () => {
    it('first buy of each distinct wallet, ranked in chain order, excluded wallets skipped', () => {
      const page = w.parseHistoryResponse(envelope([
        tx({ payer: CREATOR, slot: 1, tokenPost: '1', solToPool: 1n }),
        tx({ payer: BUYER_A, slot: 2, tokenPost: '1', solToPool: 100_000_000n }),
        tx({ payer: BUYER_A, slot: 3, tokenPost: '9', solToPool: 900_000_000n }),
        tx({ payer: BUYER_B, slot: 4, tokenPost: '1', solToPool: 200_000_000n }),
        tx({ payer: BUYER_B, slot: 5, tokenPre: '1', tokenPost: '0' }),
      ]));
      const excluded = w.exclusionSet(PAIR, MINT, [CREATOR, null]);
      const rows = w.collectBuyers(MINT, page.txs, new Set(), excluded);
      assert.deepEqual(rows.map((r) => [r.wallet, r.rank, r.sol_amount]), [[BUYER_A, 1, 0.1], [BUYER_B, 2, 0.2]]);
      assert.equal(rows[0].ts, new Date((1_763_700_000 + 2) * 1000).toISOString());
      assert.equal(rows[0].signature, sig(2));
    });

    it('stops at 50 and continues ranks after the wallets already stored (resume)', () => {
      const txs = Array.from({ length: 80 }, (_, i) =>
        w.parseTx(tx({ payer: wallet(i + 1), slot: i + 1, tokenPost: '1', solToPool: 1_000_000n }))!
      );
      const known = new Set([wallet(1), wallet(2), wallet(3)]);
      const rows = w.collectBuyers(MINT, txs, known, w.exclusionSet(PAIR, MINT, []));
      assert.equal(rows.length, 47);
      assert.equal(rows[0].wallet, wallet(4));
      assert.equal(rows[0].rank, 4);
      assert.equal(rows.at(-1)!.rank, 50);
      assert.equal(known.size, 3, 'known is not mutated');
      // Re-reading the same page after a partial write: nothing duplicated.
      const all = new Set([...known, ...rows.map((r) => r.wallet)]);
      assert.deepEqual(w.collectBuyers(MINT, txs, all, new Set()), []);
    });

    it('never keeps programs, AMM authorities, the pool or the mint', () => {
      const ex = w.exclusionSet(PAIR, MINT, [CREATOR]);
      for (const a of [PAIR, MINT, CREATOR, '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', SOL]) assert.ok(ex.has(a), a);
      assert.ok(!ex.has(BUYER_A));
      for (const a of w.NON_BUYER_ACCOUNTS) assert.ok(w.isBase58Address(a), `valid base58: ${a}`);
    });
  });

  describe('statusAfterPage', () => {
    it('done / exhausted / capped / pending', () => {
      assert.equal(w.statusAfterPage(50, '1:1', 1), 'done');
      assert.equal(w.statusAfterPage(50, null, 1), 'done');
      assert.equal(w.statusAfterPage(12, null, 1), 'exhausted');
      assert.equal(w.statusAfterPage(12, '1:1', w.MAX_PAGES_PER_MINT), 'capped');
      assert.equal(w.statusAfterPage(12, '1:1', 1), 'pending');
    });
  });

  describe('credits', () => {
    it('GTFA full metering: 10 per 100 returned, rounded up, 10 minimum', () => {
      assert.equal(w.gtfaFullCredits(0), 10);
      assert.equal(w.gtfaFullCredits(1), 10);
      assert.equal(w.gtfaFullCredits(100), 10);
      assert.equal(w.gtfaFullCredits(101), 20);
      assert.equal(w.gtfaFullCredits(1000), 100);
      assert.equal(w.creditsToReserve(w.PAGE_LIMIT), 10);
    });

    it('hard cap 600 000, never above even if a larger cap is passed', () => {
      assert.ok(w.budgetAllows(599_990, 10));
      assert.ok(!w.budgetAllows(599_991, 10));
      assert.ok(!w.budgetAllows(600_000, 10, 1_000_000));
      assert.ok(!w.budgetAllows(Number.NaN, 10));
      assert.ok(!w.budgetAllows(-1, 10));
    });

    it('estimate: (1 creator lookup + pages) × 10 per mint', () => {
      assert.equal(w.estimateCredits(1000, 2), 30_000);
      assert.equal(w.estimateCredits(0, 5), 0);
    });

    it('pacing ≥ 150 ms between request starts', () => {
      assert.equal(w.paceDelay(null, 1000), 0);
      assert.equal(w.paceDelay(1000, 1050), 100);
      assert.equal(w.paceDelay(1000, 1200), 0);
    });
  });

  describe('redactSecret', () => {
    it('removes the literal key and any api-key query value, caps the length', () => {
      const t = `error sending request for url (https://mainnet.helius-rpc.com/?api-key=${FAKE_KEY})`;
      const r = w.redactSecret(t, FAKE_KEY);
      assert.ok(!r.includes(FAKE_KEY));
      assert.ok(!w.redactSecret('x?api_key=SOMETHING&y=1').includes('SOMETHING'));
      assert.ok(!w.redactSecret(`raw ${FAKE_KEY} raw`, FAKE_KEY).includes(FAKE_KEY));
      assert.equal(w.redactSecret('a'.repeat(500)).length, 200);
    });
  });
});

describe('wallet-collect-helius', { skip: zodReady ? false : 'zod not found' }, () => {
  const h = H!;

  function mockFetch(answer: (body: unknown) => Response | Error) {
    const calls: { url: string; body: unknown }[] = [];
    const fn = (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      const a = answer(body);
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    };
    return { fn, calls };
  }

  it('sends an ascending full GTFA request with the cursor, on the fixed host', async () => {
    const m = mockFetch(() => new Response(JSON.stringify(envelope([tx({ payer: BUYER_A, slot: 1, tokenPost: '1' })], '1:0'))));
    const src = h.createHeliusSource(FAKE_KEY, m.fn);
    const page = await src.page(PAIR, '9:2', 100);
    assert.equal(page.txs.length, 1);
    assert.equal(page.next, '1:0');
    const u = new URL(m.calls[0].url);
    assert.equal(u.host, h.HELIUS_RPC_HOST);
    assert.equal(u.protocol, 'https:');
    const body = m.calls[0].body as { method: string; params: [string, Record<string, unknown>] };
    assert.equal(body.method, 'getTransactionsForAddress');
    assert.equal(body.params[0], PAIR);
    assert.equal(body.params[1].sortOrder, 'asc');
    assert.equal(body.params[1].transactionDetails, 'full');
    assert.equal(body.params[1].paginationToken, '9:2');
    assert.deepEqual(body.params[1].filters, { status: 'succeeded' });
    assert.ok(!JSON.stringify(body).includes(FAKE_KEY), 'key never in the body');
  });

  it('errors never contain the key (network error embedding the URL, HTTP, 429)', async () => {
    const net = mockFetch(() => new TypeError(`error sending request for url (https://mainnet.helius-rpc.com/?api-key=${FAKE_KEY})`));
    await assert.rejects(h.createHeliusSource(FAKE_KEY, net.fn).page(PAIR, null), (e: unknown) => {
      assert.ok(e instanceof Error && !e.message.includes(FAKE_KEY), 'redacted');
      return true;
    });
    const http = mockFetch(() => new Response('denied', { status: 403 }));
    await assert.rejects(h.createHeliusSource(FAKE_KEY, http.fn).page(PAIR, null), /HTTP 403/);
    const rl = mockFetch(() => new Response('', { status: 429 }));
    await assert.rejects(h.createHeliusSource(FAKE_KEY, rl.fn).page(PAIR, null), (e: unknown) => {
      assert.ok(e instanceof W!.HistoryError && e.rateLimited);
      return true;
    });
  });

  it('refuses a missing or malformed key without echoing it', () => {
    assert.throws(() => h.createHeliusSource(''), /unexpected format/);
    assert.throws(() => h.createHeliusSource('bad key with spaces'), (e: unknown) => {
      assert.ok(e instanceof Error && !e.message.includes('bad key'));
      return true;
    });
  });
});
