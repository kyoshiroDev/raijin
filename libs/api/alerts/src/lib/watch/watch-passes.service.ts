import { Inject, Injectable, Logger } from '@nestjs/common';
import { AnalysisClock, KeyValueStore } from '@raijin/api-analysis';
import { errorCode, randomToken } from '@raijin/api-core';
import { PrismaService } from '@raijin/api-prisma';
import { RPC_BATCH_MAX, DEXSCREENER_BATCH_MAX, type AuthoritiesBatchEntry, type PoolsBatchEntry } from '@raijin/api-solana';
import type { TokenMetadata, WatchSnapshot } from '@raijin/shared-contracts';
import { detectWatchEvents, mergeWatchSnapshot, type WatchObservation } from '@raijin/shared-risk-engine';
import { EventRecorderService, type RecordInput } from './event-recorder.service';
import { parseSnapshot, parseToken } from './snapshot';
import { WATCH_SOURCES, WatchAnalyzer, type WatchSources } from './watch-sources';

/** Verrou par mint : une seule passe à la fois sur un mint (toutes instances). */
export const MINT_LOCK_TTL_MS = 60_000;
/** Passe complète anticipée après un événement critique : au plus une par heure et par mint. */
export const EARLY_FULL_MIN_INTERVAL_MS = 3_600_000;

export interface PassCounters {
  [key: string]: number;
  mints: number;
  events: number;
  alerts: number;
  skipped: number;
  failures: number;
}

const zero = (): PassCounters => ({ mints: 0, events: 0, alerts: 0, skipped: 0, failures: 0 });

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** Code d'erreur stable (`ApiException.code`, `UpstreamError.kind`…), jamais de message. */
function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code) ? code : errorCode(error);
}

/**
 * Passes de réanalyse d'un mint (docs/ARCHITECTURE.md §11.4, §11.5) : rapide (autorités + pool,
 * par lots), holders (top 20), complète (verdict via le pipeline d'analyse, sans quota). Chaque passe :
 * verrou du mint → instantané précédent → `mergeWatchSnapshot` → `detectWatchEvents` →
 * `EventRecorderService.record` (transaction, révision optimiste). Les sources ne lèvent pas : un
 * groupe indisponible n'est jamais comparé (aucune fausse alerte).
 */
@Injectable()
export class WatchPassesService {
  private readonly logger = new Logger('WatchPasses');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WATCH_SOURCES) private readonly sources: WatchSources,
    private readonly analyzer: WatchAnalyzer,
    private readonly recorder: EventRecorderService,
    private readonly store: KeyValueStore,
    private readonly clock: AnalysisClock,
  ) {}

  /** Passe rapide d'un lot de mints (≤ 100). */
  async fast(mints: readonly string[]): Promise<PassCounters> {
    const counters = zero();
    const states = await this.prisma.mintWatchState.findMany({ where: { mint: { in: [...mints] }, unanalyzable: false }, select: { mint: true, snapshot: true } });
    if (states.length === 0) return counters;
    const list = states.map((state) => state.mint);
    const tracked = Object.fromEntries(states.map((state) => [state.mint, parseSnapshot(state.snapshot)?.pool?.address ?? null]));
    const authorities = new Map<string, AuthoritiesBatchEntry>();
    for (const lot of chunk(list, RPC_BATCH_MAX)) for (const entry of await this.sources.collectAuthoritiesBatch(lot)) authorities.set(entry.mint, entry);
    const pools = new Map<string, PoolsBatchEntry>();
    for (const lot of chunk(list, DEXSCREENER_BATCH_MAX)) for (const entry of await this.sources.collectPoolsBatch(lot, tracked)) pools.set(entry.mint, entry);

    for (const mint of list) {
      const auth = authorities.get(mint);
      const observation: WatchObservation = {
        mint,
        authorities: auth?.status === 'ok' ? auth.authorities : null,
        pool: pools.get(mint)?.pool ?? null,
      };
      await this.apply(mint, observation, counters, () => {
        if (auth?.status === 'unanalyzable') return { unanalyzable: true, lastErrorCode: 'TOKEN_UNANALYZABLE' };
        if (auth?.status === 'not_found') return { consecutiveFailures: { increment: 1 }, lastErrorCode: 'TOKEN_NOT_FOUND' };
        if (auth?.status === 'unavailable') return { lastErrorCode: `UPSTREAM_${auth.errorKind.toUpperCase()}` };
        return { consecutiveFailures: 0, lastErrorCode: null };
      });
    }
    return counters;
  }

  /** Passe holders d'un mint (top 20, `null` sans clé Helius : aucune détection `holder_sold`). */
  async holders(mint: string): Promise<PassCounters> {
    const counters = zero();
    const state = await this.prisma.mintWatchState.findUnique({ where: { mint }, select: { snapshot: true } });
    if (!state) return counters;
    const previous = parseSnapshot(state.snapshot);
    const pool = previous?.pool;
    const holders = await this.sources.collectHolders(mint, {
      excludeAddresses: pool ? [pool.address] : [],
      ...(previous?.holders ? { supply: previous.holders.supply } : {}),
    });
    await this.apply(mint, { mint, holders }, counters);
    return counters;
  }

  /** Passe complète (verdict) d'un mint : pipeline d'analyse existant, sans quota utilisateur. */
  async full(mint: string): Promise<PassCounters> {
    const counters = zero();
    const state = await this.prisma.mintWatchState.findUnique({ where: { mint }, select: { unanalyzable: true } });
    if (!state || state.unanalyzable) return counters;
    let analysis;
    try {
      analysis = await this.analyzer.analyzeForWatch(mint);
    } catch (error) {
      const code = failureCode(error);
      counters.failures += 1;
      await this.prisma.mintWatchState.updateMany({
        where: { mint },
        data: code === 'TOKEN_UNANALYZABLE' ? { unanalyzable: true, lastErrorCode: code } : { consecutiveFailures: { increment: 1 }, lastErrorCode: code },
      });
      this.logger.warn(`Passe complète en échec (${code})`);
      return counters;
    }
    const { result, analysisId } = analysis;
    const reasonCodes = [...new Set(result.checks.flatMap((check) => check.reasonCodes))].slice(0, 40);
    const observation: WatchObservation = {
      mint,
      verdict: { verdict: result.verdict, engineVersion: result.engineVersion, analysisId, reasonCodes, observedAt: result.analyzedAt },
    };
    await this.apply(mint, observation, counters, () => ({ consecutiveFailures: 0, lastErrorCode: null }), result.token, {
      verdict: result.verdict,
      checkedAt: new Date(result.analyzedAt),
    });
    return counters;
  }

  /** Fusion, détection et écriture sous verrou ; une révision concurrente fait rejouer une fois. */
  private async apply(
    mint: string,
    observation: WatchObservation,
    counters: PassCounters,
    stateUpdate: () => RecordInput['state'] = () => ({}),
    token?: TokenMetadata,
    verdict?: RecordInput['verdict'],
  ): Promise<void> {
    const lockKey = `lock:watch:mint:${mint}`;
    const owner = randomToken(12);
    const locked = await this.store.setIfAbsent(lockKey, owner, MINT_LOCK_TTL_MS);
    if (locked === false) {
      counters.skipped += 1;
      return;
    }
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const state = await this.prisma.mintWatchState.findUnique({ where: { mint }, select: { snapshot: true, revision: true, lastEarlyFullAt: true, token: true } });
        if (!state) return;
        const previous: WatchSnapshot | null = parseSnapshot(state.snapshot);
        const next = mergeWatchSnapshot(previous, observation);
        const events = detectWatchEvents(previous, next);
        const update = { ...stateUpdate(), ...this.earlyFull(events, state.lastEarlyFullAt) };
        const result = await this.recorder.record({
          mint,
          revision: state.revision,
          next,
          events,
          token: token ?? parseToken(state.token),
          state: update,
          verdict,
        });
        if (result.conflict) continue;
        counters.mints += 1;
        counters.events += result.events;
        counters.alerts += result.alerts;
        counters.skipped += result.skippedByCooldown;
        return;
      }
      counters.skipped += 1;
    } catch (error) {
      counters.failures += 1;
      this.logger.error(`Passe non enregistrée (${errorCode(error)})`);
    } finally {
      if (locked) await this.store.deleteIfEquals(lockKey, owner);
    }
  }

  /** Événement critique (LP, mint, freeze) : passe complète anticipée, au plus une par heure. */
  private earlyFull(events: readonly { type: string; severity: string }[], lastEarlyFullAt: Date | null): RecordInput['state'] {
    const critical = events.some((event) => event.severity === 'danger' && event.type !== 'verdict_degraded');
    const now = this.clock.now();
    if (!critical || (lastEarlyFullAt && now.getTime() - lastEarlyFullAt.getTime() < EARLY_FULL_MIN_INTERVAL_MS)) return {};
    return { nextFullAt: now, lastEarlyFullAt: now };
  }
}
