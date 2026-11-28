import { Inject, Injectable, Logger } from '@nestjs/common';
import { BENCH_CLOCK, BenchRedis, type BenchClock } from '@raijin/bench-core';
import { RISK_ENGINE_VERSION } from '@raijin/shared-risk-engine';
import { buildQualityReport, fnv1a32, stableStringify, type EngineVariant, type QualityReport } from '@raijin/bench-verdicts';
import { QualityStore } from './quality-store';

/**
 * Rapport de justesse précalculé (phase 9, T9 c). Mesure : 10 000 verdicts simulés, 3 horizons, 2 variantes →
 * médiane ≈ 1,9 s et ≈ 94 Mo de tas par calcul (20 000 verdicts : ≈ 6 s, ≈ 120 Mo), au-delà du seuil de 300 ms /
 * 50 Mo du plan. Le rapport est donc calculé la nuit par `verdict-aggregate` (03:05, verrou BullMQ, `job_runs`) et
 * l'endpoint lit le précalcul. Recalcul à la demande seulement si le précalcul manque, a plus de 36 h, ou ne
 * correspond plus au moteur publié ou aux variantes activées (empreinte) : jamais un rapport faux, au pire un appel lent.
 */

/** Fenêtre du rapport (identique à l'ancien calcul à chaque appel). */
export const QUALITY_DAYS = 365;
export const QUALITY_MAX_RECORDS = 20_000;
/** Au-delà, le précalcul est jugé périmé (job nocturne en échec) et recalculé à la demande. */
export const QUALITY_REPORT_MAX_AGE_MS = 36 * 3_600_000;
/** Clé Redis (connexion préfixée `raijin-bench:`) et durée de conservation. */
export const QUALITY_REPORT_KEY = 'quality:report';
const QUALITY_REPORT_TTL_S = 7 * 86_400;
const DAY_MS = 86_400_000;

export interface CachedQualityReport {
  /** Empreinte du moteur publié et des variantes activées au moment du calcul. */
  readonly signature: string;
  readonly computedAt: string;
  readonly report: QualityReport;
}

/** Empreinte (FNV-1a) de ce qui change le rapport hors données : version du moteur, variantes activées. */
export function qualitySignature(variants: readonly EngineVariant[], engineVersion: string = RISK_ENGINE_VERSION): string {
  return fnv1a32(stableStringify({ engineVersion, variants }));
}

/** Stockage du précalcul. */
export abstract class QualityReportCache {
  abstract get(): Promise<CachedQualityReport | null>;
  abstract set(entry: CachedQualityReport): Promise<void>;
}

/** Repli en mémoire (dev/test sans Redis). */
export class MemoryQualityReportCache extends QualityReportCache {
  private entry: CachedQualityReport | null = null;

  async get(): Promise<CachedQualityReport | null> {
    return this.entry;
  }

  async set(entry: CachedQualityReport): Promise<void> {
    this.entry = entry;
  }
}

/** Sous-ensemble d'ioredis utilisé (connexion préfixée). */
export interface QualityReportRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

/** Redis `raijin-bench:quality:report` ; toute erreur Redis retombe sur la copie en mémoire du processus. */
export class RedisQualityReportCache extends QualityReportCache {
  private readonly memory = new MemoryQualityReportCache();

  constructor(private readonly redis: QualityReportRedis | null) {
    super();
  }

  async get(): Promise<CachedQualityReport | null> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(QUALITY_REPORT_KEY);
        if (raw !== null) return JSON.parse(raw) as CachedQualityReport;
      } catch {
        // Redis indisponible ou valeur illisible : copie locale.
      }
    }
    return this.memory.get();
  }

  async set(entry: CachedQualityReport): Promise<void> {
    await this.memory.set(entry);
    if (!this.redis) return;
    try {
      await this.redis.set(QUALITY_REPORT_KEY, JSON.stringify(entry), 'EX', QUALITY_REPORT_TTL_S);
    } catch {
      // La copie en mémoire suffit jusqu'au prochain calcul.
    }
  }
}

export function createQualityReportCache(redis: BenchRedis): QualityReportCache {
  return new RedisQualityReportCache(redis.prefixed as QualityReportRedis | null);
}

@Injectable()
export class QualityReportService {
  private readonly logger = new Logger('BenchQualityReport');
  private inflight: Promise<CachedQualityReport> | null = null;

  constructor(
    private readonly store: QualityStore,
    private readonly cache: QualityReportCache,
    @Inject(BENCH_CLOCK) private readonly clock: BenchClock,
  ) {}

  /** Rapport servi par `GET /api/verdicts/quality` : le précalcul s'il est à jour, sinon un calcul (partagé). */
  async current(): Promise<QualityReport> {
    const variants = await this.store.enabledVariants();
    const signature = qualitySignature(variants);
    const cached = await this.cache.get();
    const age = cached ? this.clock().getTime() - Date.parse(cached.computedAt) : Number.POSITIVE_INFINITY;
    if (cached && cached.signature === signature && age >= 0 && age <= QUALITY_REPORT_MAX_AGE_MS) return cached.report;
    this.logger.log(cached ? 'Précalcul du rapport de justesse périmé : recalcul à la demande' : 'Aucun précalcul du rapport de justesse : calcul à la demande');
    return (await this.compute(variants)).report;
  }

  /** Précalcul nocturne (`verdict-aggregate`). */
  async refresh(): Promise<{ quality_records: number; quality_ms: number }> {
    const started = Date.now();
    const entry = await this.compute(await this.store.enabledVariants());
    return { quality_records: entry.report.records, quality_ms: Date.now() - started };
  }

  /** Un seul calcul à la fois : les appels concurrents partagent le même résultat. */
  private compute(variants: readonly EngineVariant[]): Promise<CachedQualityReport> {
    if (!this.inflight) {
      this.inflight = this.build(variants).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async build(variants: readonly EngineVariant[]): Promise<CachedQualityReport> {
    const now = this.clock();
    const since = new Date(now.getTime() - QUALITY_DAYS * DAY_MS).toISOString();
    const measured = await this.store.loadMeasured(since, QUALITY_MAX_RECORDS);
    const entry: CachedQualityReport = {
      signature: qualitySignature(variants),
      computedAt: now.toISOString(),
      report: buildQualityReport({ simulated: false, ...measured }, variants),
    };
    await this.cache.set(entry);
    return entry;
  }
}
