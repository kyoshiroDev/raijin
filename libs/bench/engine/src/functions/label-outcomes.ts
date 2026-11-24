// Edge Function: label-outcomes (feat/x3-model, fix/measurement-and-criteria, fix/label-checkpoints, feat/strategy-lab,
// feat/lab-v2). Called every 2 minutes by pg_cron at ODD minutes ('1-59/2 * * * *', see supabase/sql/schedule_label.sql),
// so it never overlaps scan-tokens, which also calls GeckoTerminal at even minutes.
// 1. Backfill (« rattrapage »): tokens without a signal_outcomes row get one from their FIRST token_snapshots row
//    (rpc x3_backfill_candidates, ≤ 200 per run, ON CONFLICT DO NOTHING), on the calls of minutes 1, 11, 21… only
//    (every 10 min, as before the 2-minute cadence).
// 2. Checkpoints: every row carries next_label_at (set to detection + 12 h on insert by a trigger, then by
//    nextLabelAt() with each UPDATE: detection + 7 days, then every 6 h while still pending past the horizon or after a
//    failure, null once final). Only pending rows with next_label_at <= now are read (a null checkpoint is due only for
//    a never-labelled row), oldest checkpoint first.
// 3. Candle capture for the backtest laboratory: signal_outcomes, preset_signals and (lab-v2) backtest_events carry
//    candles_1m_at (detection / event + 6 h; null for detections whose pair was ≥ 48 h old, migration 20261119100000)
//    and candles_5m_at (+ 72 h), set on insert by triggers. A due item = ONE GeckoTerminal request (fetchCandleWindow:
//    1-minute × 360 or 5-minute × 864) written as ONE compact public.ohlcv_candles row (upsert, duplicates ignored),
//    then the column is set to null (candle-queue.ts candlesDoneUpdate / candlesFailureUpdate). A window already
//    covered by a stored row of the same mint (isWindowCovered) is marked done without a request.
// 4. One merged work queue (_shared/candle-queue.ts mergeWorkQueue, lab-v2 §1 + fix/lab-priority-exploratory +
//    feat/calm-sl-test): 1 1-minute candles of the detections whose pair was < 24 h old (absolute priority, read apart),
//    2 the other 1-minute candles of the detections (pair < 48 h), 3 event candles 1 min (young_calm_ev /
//    young_frenzy_ev only), 4 preset labels, 5 scan labels, 6 5-minute candles. A failed read only removes that group. chore/slim-down: the
//    radar labels (early_outcomes) and the labels / candles of the archived presets (preset_signals momentum / strict /
//    young_strong, backtest_events of the removed lab presets) are no longer processed.
// 5. Measured before lab-v2: every 10-minute run hit a 429 after ~4 requests (≈ 13 rows/h). Now (label-queue.ts
//    LABEL_PACE_2MIN): ≤ 5 requests per call, one every 8 s, the FIRST 429 stops the call (no retry: the item is not
//    counted as a failure and stays first in the queue for the next call), no new request after 40 s, everything
//    aborted at 50 s (pg_net timeout 55 s, next call 2 min later).
// 6. Journal: one public.label_runs row per call (requests, 429, rows written, labels, candles, failures, queue, ms):
//    measured throughput of rpc('backfill_progress'). Best effort, purged after 7 days.
// Response { backfilled, labelled, finalised, failed, rateLimited, calls, byTable, candles, ms }.
// Deploy: supabase functions deploy label-outcomes --no-verify-jwt
// Secrets: CRON_SECRET (required, same as scan-tokens). GeckoTerminal is called without key.
import type { SupabaseClient } from '../db/bench-db';
import { type CandleHistory, fetchCandleHistory, fetchCandleWindow } from '../ported/gecko-history';
import { candlePlan, isWindowCovered, ohlcvRow } from '../ported/candles';
import {
  CANDLE_TABLES,
  candleColumn,
  LAB_EVENT_PRESETS,
  type CandleItem,
  candleQueueColumns,
  candlesDoneUpdate,
  candlesFailureUpdate,
  type CandleTable,
  itemWindow,
  mergeWorkQueue,
  parseCandleRow,
  PRIORITY_PAIR_AGE_H,
} from '../ported/candle-queue';
import { labelOutcome } from '../ported/outcomes';
import { backfillRow, type BackfillCandidate, labelFailureUpdate, labelUpdate, type OutcomeInsert } from '../ported/x3-rows';
import {
  canStartRequest,
  LABEL_PACE_2MIN,
  LABEL_TABLES,
  labelQueueColumns,
  type LabelItem,
  type LabelTable,
  parseLabelRow,
  withNextLabelAt,
} from '../ported/label-queue';
import { labelRunRow } from '../ported/label-journal';
import { SIGNAL_PRESETS } from '../ported/presets';

const BACKFILL_LIMIT = 200;
const INSERT_CHUNK = 100;
const PACE = LABEL_PACE_2MIN;
/**
 * Work items (labels + candle captures) per call at most. More than the request cap: an item already covered by a
 * stored candle window is done without a request, the next one can then use the slot.
 */
const MAX_ROWS = 8;
/** Rows read per table / candle group before the merge (enough to fill every slot from any group). */
const READ_PER_TABLE = MAX_ROWS;
/** Backfill only on the calls of these minutes (every 10 min). */
const BACKFILL_MINUTE_MOD = { mod: 10, at: 1 } as const;
/** Rows younger than this have (almost) no candle after the detection yet. */
const MIN_AGE_MS = 60 * 60_000;
/** A row still pending this long after detection is abandoned (pool gone / never any candle): stays pending. */
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;

interface LabelCounts {
  labelled: number;
  finalised: number;
  failed: number;
}

interface CandleCounts {
  /** ohlcv_candles rows written (a duplicate ignored by the upsert counts too: the window is stored). */
  captured: number;
  /** GeckoTerminal answered without any valid candle in the window: marked done. */
  empty: number;
  /** Already covered by a stored window of the same mint: marked done without a request. */
  covered: number;
  failed: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export interface LabelOutcomesDeps {
  readonly db: SupabaseClient;
}

/**
 * Port Node de l'Edge Function `label-outcomes` (job `label-outcomes`, `1-59/2 * * * *`, rattrapage aux minutes
 * 1, 11, 21…). Corps inchangé ; `Response.json(stats)` devient la valeur renvoyée et la réponse 500 une exception
 * (après le journal `label_runs`, comme avant).
 */
export async function runLabelOutcomes(deps: LabelOutcomesDeps) {
  const started = Date.now();
  const db = deps.db;
  const byTable: Record<LabelTable, LabelCounts> = {
    signal_outcomes: { labelled: 0, finalised: 0, failed: 0 },
    preset_signals: { labelled: 0, finalised: 0, failed: 0 },
  };
  const candles: Record<CandleTable, CandleCounts> = {
    signal_outcomes: { captured: 0, empty: 0, covered: 0, failed: 0 },
    preset_signals: { captured: 0, empty: 0, covered: 0, failed: 0 },
    backtest_events: { captured: 0, empty: 0, covered: 0, failed: 0 },
  };
  const stats = {
    backfilled: 0,
    labelled: 0,
    finalised: 0,
    failed: 0,
    rateLimited: false,
    calls: 0,
    byTable,
    candles,
    ms: 0,
  };
  let queued = 0;

  try {
    // 1. Backfill: bounded, best effort (a failure does not prevent labelling), every 10 minutes.
    if (new Date(started).getUTCMinutes() % BACKFILL_MINUTE_MOD.mod === BACKFILL_MINUTE_MOD.at) try {
      const { data, error } = await db.rpc('x3_backfill_candidates', { p_limit: BACKFILL_LIMIT });
      if (error) throw new Error(error.message);
      const now = Date.now();
      const rows = ((data ?? []) as BackfillCandidate[])
        .map((c) => backfillRow(c, now))
        .filter((r): r is OutcomeInsert => r !== null);
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        const { data: ins, error: insErr } = await db
          .from('signal_outcomes')
          .upsert(rows.slice(i, i + INSERT_CHUNK), { onConflict: 'mint', ignoreDuplicates: true })
          .select('mint');
        if (insErr) throw new Error(insErr.message);
        stats.backfilled += ins?.length ?? 0;
      }
    } catch (e) {
      console.warn('label backfill', msg(e));
    }

    // 2. Due label rows of each table (checkpoint reached) and due candle captures, then one merged work queue. A
    //    failed read (e.g. a migration not applied yet) only removes that group from this run.
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const reads = await Promise.all(LABEL_TABLES.map(async (table) => {
      try {
        let q = db
          .from(table)
          .select(labelQueueColumns(table))
          .eq('status', 'pending')
          .lte('detected_at', iso(now - MIN_AGE_MS))
          .gte('detected_at', iso(now - MAX_AGE_MS));
        // chore/slim-down: rows of the archived presets (momentum, strict, young_strong) are no longer labelled.
        if (table === 'preset_signals') q = q.in('preset', [...SIGNAL_PRESETS]);
        const { data, error } = await q
          .or(`next_label_at.lte."${iso(now)}",and(next_label_at.is.null,labelled_at.is.null)`)
          .order('next_label_at', { ascending: true, nullsFirst: true })
          .order('detected_at', { ascending: true })
          .limit(READ_PER_TABLE);
        if (error) {
          console.warn('label queue', table, error.message.slice(0, 200));
          return [];
        }
        return ((data ?? []) as unknown[]).map((r) => parseLabelRow(table, r)).filter((q): q is LabelItem => q !== null);
      } catch (e) {
        console.warn('label queue', table, msg(e));
        return [];
      }
    }));
    // One read per (table, timeframe) on the partial indexes candles_<tf>_at, oldest due first, plus one read of the
    // 1-minute captures of the detections whose pair was < 24 h old (feat/calm-sl-test: first rank of the queue, read
    // apart so an older backlog of the second rank can never hide them).
    const candleGroups: { table: CandleTable; tf: '1m' | '5m'; young?: true }[] = [
      ...(['signal_outcomes', 'preset_signals'] as const).map((table) => ({ table, tf: '1m' as const, young: true as const })),
      ...CANDLE_TABLES.flatMap((table) => (['1m', '5m'] as const).map((tf) => ({ table, tf }))),
    ];
    const candleReads = await Promise.all(candleGroups.map(async ({ table, tf, young }) => {
      try {
        const col = candleColumn(tf);
        let q = db
          .from(table)
          .select(candleQueueColumns(table))
          .not(col, 'is', null)
          .lte(col, iso(now));
        if (young) q = q.lt('pair_age_h', PRIORITY_PAIR_AGE_H);
        // Archived (event) presets keep their queue columns but are no longer captured.
        if (table === 'backtest_events') q = q.in('preset', [...LAB_EVENT_PRESETS]);
        if (table === 'preset_signals') q = q.in('preset', [...SIGNAL_PRESETS]);
        const { data, error } = await q
          .order(col, { ascending: true })
          .limit(READ_PER_TABLE);
        if (error) {
          console.warn('candle queue', table, tf, error.message.slice(0, 200));
          return [];
        }
        return ((data ?? []) as unknown[]).flatMap((r) => parseCandleRow(table, r, now));
      } catch (e) {
        console.warn('candle queue', table, tf, msg(e));
        return [];
      }
    }));
    const queue = mergeWorkQueue(reads.flat(), candleReads.flat(), MAX_ROWS);
    queued = queue.length;

    // 3. Work sequentially, one GeckoTerminal request every PACE.spacingMs, ≤ PACE.maxRequests per call.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), Math.max(0, started + PACE.abortMs - Date.now()));
    let lastCallAt = 0;
    const canStart = () => canStartRequest(stats.calls, Date.now() - started, PACE) && !controller.signal.aborted;
    const pace = async () => {
      const wait = lastCallAt + PACE.spacingMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();
      stats.calls++;
    };
    /** One paced request; a 429 = 'stop' (end of the call, never an item failure: the item stays first in the queue). */
    const paced = async (once: () => Promise<CandleHistory>): Promise<CandleHistory | 'stop'> => {
      await pace();
      const history = await once();
      if (history.status === 'rate_limited') {
        // LABEL_PACE_2MIN forbids retries: the first 429 ends the call, whatever the time left.
        stats.rateLimited = true;
        return 'stop';
      }
      return history;
    };

    const labelItem = async (q: LabelItem): Promise<'stop' | 'next'> => {
      const history = await paced(() =>
        fetchCandleHistory(q.pairAddress, q.mint, q.detectedAtMs, Date.now(), {
          signal: controller.signal,
          maxPages: 1, // one request per row: 15-minute candles over the whole window
        })
      );
      if (history === 'stop') return 'stop';
      if (history.status !== 'ok' && controller.signal.aborted) return 'stop'; // budget exhausted mid-row: not a real failure
      const at = Date.now();
      const payload = history.status === 'ok'
        ? withNextLabelAt(labelUpdate(labelOutcome(q.entryPrice, q.detectedAtMs, history.candles, at), q.attempts, at), q.detectedAtMs, at, true)
        : withNextLabelAt(labelFailureUpdate(history.error ?? 'label failed', q.attempts, at) as { status?: 'pending' | 'final' }, q.detectedAtMs, at, false);
      const counts = byTable[q.table];
      const { error } = await db.from(q.table).update(payload).eq(q.keyColumn, q.keyValue).eq('status', 'pending');
      if (error) {
        counts.failed++;
        console.warn('label update', q.table, error.message.slice(0, 200));
        return 'next';
      }
      if (history.status !== 'ok') {
        counts.failed++;
        return 'next';
      }
      counts.labelled++;
      if ('status' in payload && payload.status === 'final') counts.finalised++;
      return 'next';
    };

    /** Queue column update of a candle item; false (logged) on a database error. */
    const updateCandleQueue = async (q: CandleItem, payload: Record<string, unknown>): Promise<boolean> => {
      const { error } = await db.from(q.table).update(payload).eq(q.keyColumn, q.keyValue);
      if (error) console.warn('candle queue update', q.table, error.message.slice(0, 200));
      return !error;
    };

    const captureItem = async (q: CandleItem): Promise<'stop' | 'next'> => {
      const counts = candles[q.table];
      const w = itemWindow(q);
      if (!w) {
        counts.failed++;
        await updateCandleQueue(q, candlesFailureUpdate(q.tf, q.attempts, Date.now(), 'invalid'));
        return 'next';
      }
      // Already stored (other detection of the same mint minutes apart, or this one after a lost queue update).
      try {
        const { data, error } = await db
          .from('ohlcv_candles')
          .select('tf, detected_at')
          .eq('mint', q.mint)
          .eq('tf', q.tf)
          .gte('detected_at', iso(q.detectedAtMs - 3 * 24 * 3_600_000))
          .lte('detected_at', iso(q.detectedAtMs + 3 * 24 * 3_600_000))
          .limit(50);
        if (!error && isWindowCovered((data ?? []) as { tf: unknown; detected_at: unknown }[], w)) {
          if (await updateCandleQueue(q, candlesDoneUpdate(q.tf))) counts.covered++;
          return 'next';
        }
      } catch {
        // no coverage information: capture
      }
      if (!canStart()) return 'stop';
      const history = await paced(() => fetchCandleWindow(q.pairAddress, q.mint, candlePlan(w), { signal: controller.signal }));
      if (history === 'stop') return 'stop';
      if (history.status !== 'ok' && controller.signal.aborted) return 'stop';
      const at = Date.now();
      if (history.status !== 'ok') {
        counts.failed++;
        const status = history.status === 'not_found' || history.status === 'invalid' ? history.status : 'error';
        await updateCandleQueue(q, candlesFailureUpdate(q.tf, q.attempts, at, status));
        return 'next';
      }
      const row = ohlcvRow({
        mint: q.mint,
        pool: q.pairAddress,
        tf: q.tf,
        candles: history.candles,
        source: q.table,
        detectedAtMs: q.detectedAtMs,
        fetchedAtMs: at,
      });
      if (row) {
        const { error } = await db.from('ohlcv_candles').upsert(row, { onConflict: 'mint,tf,ts_start', ignoreDuplicates: true });
        if (error) {
          // Not stored: keep the item due (retried later, counted as a failed attempt).
          counts.failed++;
          console.warn('candle insert', q.table, error.message.slice(0, 200));
          await updateCandleQueue(q, candlesFailureUpdate(q.tf, q.attempts, at, 'error'));
          return 'next';
        }
      }
      if (await updateCandleQueue(q, candlesDoneUpdate(q.tf))) {
        if (row) counts.captured++;
        else counts.empty++;
      }
      return 'next';
    };

    try {
      for (const w of queue) {
        if (!canStart()) break;
        const r = w.kind === 'label' ? await labelItem(w.item) : await captureItem(w.item);
        if (r === 'stop') break;
      }
    } finally {
      clearTimeout(abortTimer);
    }

    for (const c of Object.values(byTable)) {
      stats.labelled += c.labelled;
      stats.finalised += c.finalised;
      stats.failed += c.failed;
    }
    stats.ms = Date.now() - started;
    const queuedLabels = Object.fromEntries(LABEL_TABLES.map((t, i) => [t, reads[i]!.length]));
    const queuedCandles = Object.fromEntries(candleGroups.map((g, i) => [`${g.table}:${g.tf}`, candleReads[i]!.length]));
    console.log('label', JSON.stringify({ ...stats, queue: queue.length, queued: queuedLabels, queuedCandles }));
    await journal(db, stats, candles, queued);
    return stats;
  } catch (e) {
    console.error('label failed', msg(e));
    stats.ms = Date.now() - started;
    await journal(db, stats, candles, queued);
    throw new Error('Label failed', { cause: e });
  }
}

/** One public.label_runs row (counts only), best effort: a journal failure never fails the call. */
async function journal(
  db: SupabaseClient,
  stats: { labelled: number; failed: number; rateLimited: boolean; calls: number; ms: number },
  candles: Record<CandleTable, CandleCounts>,
  queued: number,
): Promise<void> {
  try {
    const c = Object.values(candles);
    const row = labelRunRow({
      requests: stats.calls,
      rateLimited: stats.rateLimited ? 1 : 0,
      labels: stats.labelled,
      candles: c.reduce((a, x) => a + x.captured + x.empty + x.covered, 0),
      failed: stats.failed + c.reduce((a, x) => a + x.failed, 0),
      queued,
      ms: stats.ms,
    });
    const { error } = await db.from('label_runs').insert(row);
    if (error) console.warn('label journal', error.message.slice(0, 200));
  } catch (e) {
    console.warn('label journal', msg(e));
  }
}
