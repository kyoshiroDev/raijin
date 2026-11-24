import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BENCH_CLOCK, BENCH_CONFIG, BenchJobRegistry, BenchNotifier, BenchStatusService, benchAlertRecipient, type BenchClock, type BenchConfig } from '@raijin/bench-core';
import type { RiskFacts } from '@raijin/shared-contracts';
import { RISK_ENGINE_VERSION } from '@raijin/shared-risk-engine';
import {
  FOLLOW_UP_HORIZONS,
  buildQualityReport,
  purgeCutoffs,
  shouldNotifyStorage,
  type StorageLevel,
} from '@raijin/bench-verdicts';
import { MarketReader } from './market-reader';
import { QualityReportService } from './quality-report';
import { PURGE_STEPS, QualityStore } from './quality-store';
import { aggregateDaily, buildObservation, buildVerdictRow, dueWindow, UNKNOWN_MARKET } from './verdict-model';

/** Faits du moteur pour un mint (`api-solana` `collectFacts`, profil complet ≈ 14 crédits Helius). */
export abstract class FactsSource {
  abstract collect(mint: string): Promise<RiskFacts | null>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Détections récentes examinées par passage (les plus récentes d'abord). */
const DETECTION_LOOKBACK_MS = 6 * HOUR_MS;
const DETECTION_READ_MAX = 60;
/** Verdicts enregistrés par passage (toutes les 15 min) : ≈ 270 détections / jour ≈ 3 par passage (BENCH.md §9 P1). */
export const DEFAULT_VERDICTS_PER_RUN = 6;
export const MAX_VERDICTS_PER_RUN = 20;
/** Observations par horizon et par passage. */
const OBSERVATIONS_PER_HORIZON = 120;
/** Agrégats recalculés sur les derniers jours (7 j + tolérance 24 h : issues encore mobiles). */
const AGGREGATE_DAYS = 10;
/** Période du rejeu nocturne des variantes activées. */
const REPLAY_DAYS = 90;
const MEASURED_MAX = 20_000;

export function verdictsPerRun(config: Pick<BenchConfig, 'solanaEnv'>): number {
  const raw = config.solanaEnv['BENCH_VERDICTS_PER_RUN']?.trim();
  if (!raw || !/^\d{1,3}$/.test(raw)) return DEFAULT_VERDICTS_PER_RUN;
  return Math.min(MAX_VERDICTS_PER_RUN, Number(raw));
}

/**
 * Mesure des verdicts (phase 7 bis branchée, ARCHITECTURE §16) et entretien de la base :
 * - `verdict-follow-up` (toutes les 15 min) : verdict du moteur publié sur les nouvelles détections, puis relève des
 *   verdicts dont la fenêtre 24 h / 72 h / 7 j est ouverte (observation hors fenêtre jamais réaffectée) ;
 * - `verdict-aggregate` (03:05) : agrégats quotidiens + rejeu des variantes **activées** (drapeau `enabled`, jamais
 *   remontées dans Raijin sans PR), puis précalcul du rapport de justesse lu par `GET /api/verdicts/quality` ;
 * - `retention-purge` (03:15) : purges de pg_cron dans l'ordre, puis verdicts (365 j) et `job_runs` (30 j) ;
 * - `storage-check` (toutes les heures) : alerte 80 % / 95 % (push + e-mail, seulement à la hausse, coupée en ombre).
 * Le banc mesure le risque pour améliorer les verdicts : aucune stratégie de gain n'est calculée ici.
 */
@Injectable()
export class BenchQualityJobs implements OnModuleInit {
  private readonly logger = new Logger('BenchQuality');

  constructor(
    @Inject(BENCH_CONFIG) private readonly config: BenchConfig,
    @Inject(BENCH_CLOCK) private readonly clock: BenchClock,
    private readonly registry: BenchJobRegistry,
    private readonly store: QualityStore,
    private readonly facts: FactsSource,
    private readonly market: MarketReader,
    private readonly status: BenchStatusService,
    private readonly notifier: BenchNotifier,
    private readonly reports: QualityReportService,
  ) {}

  onModuleInit(): void {
    this.registry.register('verdict-follow-up', async () => {
      const now = this.clock();
      return { ...(await this.recordVerdicts(now)), ...(await this.observeDue(now)) };
    });
    this.registry.register('verdict-aggregate', () => this.aggregate(this.clock()));
    this.registry.register('retention-purge', () => this.purge(this.clock()));
    this.registry.register('storage-check', () => this.storageCheck());
  }

  async recordVerdicts(now: Date): Promise<{ candidates: number; recorded: number; inconclusive: number; unavailable: number }> {
    const stats = { candidates: 0, recorded: 0, inconclusive: 0, unavailable: 0 };
    const recent = await this.store.recentDetections(new Date(now.getTime() - DETECTION_LOOKBACK_MS).toISOString(), DETECTION_READ_MAX);
    const done = await this.store.recordedMints(recent, RISK_ENGINE_VERSION);
    const todo = [...new Set(recent.filter((m) => !done.has(m)))].slice(0, verdictsPerRun(this.config));
    stats.candidates = todo.length;
    if (todo.length === 0) return stats;
    const [markets, supplies] = await Promise.all([this.market.markets(todo), this.market.supplies(todo)]);
    for (const mint of todo) {
      let facts: RiskFacts | null = null;
      try {
        facts = await this.facts.collect(mint);
      } catch {
        facts = null;
      }
      if (!facts) {
        stats.unavailable++;
        continue;
      }
      const row = buildVerdictRow(facts, markets.get(mint) ?? UNKNOWN_MARKET, supplies.get(mint) ?? null);
      if (!row) {
        stats.inconclusive++;
        continue;
      }
      if (await this.store.insertVerdict(row)) stats.recorded++;
    }
    return stats;
  }

  async observeDue(now: Date): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const horizon of FOLLOW_UP_HORIZONS) {
      const { from, to } = dueWindow(horizon, now);
      const due = await this.store.dueRecords(horizon, from, to, OBSERVATIONS_PER_HORIZON);
      out[`observed_${horizon}`] = 0;
      if (due.length === 0) continue;
      const mints = [...new Set(due.map((r) => r.mint))];
      const [markets, supplies] = await Promise.all([this.market.markets(mints), this.market.supplies(mints)]);
      for (const record of due) {
        const { observation, classification } = buildObservation(record, horizon, markets.get(record.mint) ?? UNKNOWN_MARKET, supplies.get(record.mint) ?? null, now);
        await this.store.insertObservation(observation, classification);
        out[`observed_${horizon}`] = (out[`observed_${horizon}`] ?? 0) + 1;
      }
    }
    return out;
  }

  async aggregate(now: Date): Promise<{ records: number; metric_rows: number; variants: number; quality_records: number; quality_ms: number }> {
    const recent = await this.store.loadMeasured(new Date(now.getTime() - AGGREGATE_DAYS * DAY_MS).toISOString(), MEASURED_MAX);
    const metricRows = await this.store.upsertDailyMetrics(aggregateDaily(recent.records, recent.observations));
    const variants = await this.store.enabledVariants();
    if (variants.length > 0) {
      const history = await this.store.loadMeasured(new Date(now.getTime() - REPLAY_DAYS * DAY_MS).toISOString(), MEASURED_MAX);
      const report = buildQualityReport({ simulated: false, ...history }, variants);
      const replay = report.horizons.find((h) => h.horizon === '7d')?.replay;
      const period = report.validationPeriod ?? report.period;
      if (replay && period) {
        for (const v of replay.variants) {
          await this.store.insertReplay({
            variantId: v.id,
            fingerprint: v.fingerprint,
            referenceVersion: replay.reference.version,
            variantVersion: v.version,
            from: period.from,
            to: period.to,
            records: replay.replayed,
            skipped: replay.skippedFactsVersion,
            report: { horizon: replay.horizon, positive: replay.positive, reference: replay.reference, variant: v },
          });
        }
      }
    }
    const quality = await this.reports.refresh();
    return { records: recent.records.length, metric_rows: metricRows, variants: variants.length, ...quality };
  }

  /** Agrégats d'abord (job `verdict-aggregate` à 03:05), puis purge à étapes ordonnées. Une étape en échec n'arrête pas les suivantes. */
  async purge(now: Date): Promise<Record<string, number | string>> {
    const cutoffs = purgeCutoffs(now);
    const out: Record<string, number | string> = {};
    const failed: string[] = [];
    for (const step of PURGE_STEPS) {
      try {
        out[step] = await this.store.purge(step, cutoffs);
      } catch (e) {
        failed.push(step);
        this.logger.warn(`Purge ${step} en échec (${(e as { code?: string }).code ?? 'erreur'})`);
      }
    }
    if (failed.length > 0) throw new Error(`purge en échec : ${failed.join(', ')}`);
    return out;
  }

  async storageCheck(): Promise<{ level: StorageLevel; ratio: number; notified: boolean }> {
    const storage = await this.status.storage();
    if (!storage) throw new Error('taille de la base indisponible');
    const previous = await this.store.storageLevel();
    const notify = shouldNotifyStorage(previous, storage.level);
    let notified = false;
    if (notify) notified = await this.alertStorage(storage.level, storage.ratio, storage.used_bytes, storage.allocated_bytes);
    // Niveau mémorisé même en mode ombre (pas de rafale d'alertes à la bascule) ; la baisse est mémorisée sans alerte.
    if (previous !== storage.level) await this.store.setStorageLevel(storage.level, storage.ratio);
    return { level: storage.level, ratio: Math.round(storage.ratio * 10_000) / 10_000, notified };
  }

  private async alertStorage(level: StorageLevel, ratio: number, used: number, allocated: number): Promise<boolean> {
    const pct = Math.round(ratio * 100);
    const subject = level === 'critical' ? `Banc : base presque pleine (${pct} %)` : `Banc : base remplie à ${pct} %`;
    const text =
      `La base raijin_bench occupe ${(used / 1024 ** 2).toFixed(0)} Mio sur ${(allocated / 1024 ** 2).toFixed(0)} Mio alloués (${pct} %).\n` +
      `Seuils : 80 % (alerte), 95 % (critique). Rétention : snapshots 30 j, verdicts 365 j, job_runs 30 j (purge 03:15 UTC).\n` +
      `Actions possibles : agrandir BENCH_DB_ALLOCATED_BYTES si le disque le permet, ou réduire la rétention.`;
    let sent = false;
    const to = benchAlertRecipient(this.config.mail);
    if (to) {
      const mail = await this.notifier.sendMail({ to, subject, text });
      sent ||= mail.status === 'sent';
    }
    if (this.notifier.pushConfigured) {
      for (const target of await this.store.pushTargets()) {
        const result = await this.notifier.sendBenchPush(
          target,
          { notification: { title: subject, body: `Base du banc à ${pct} % de l’espace alloué.`, icon: '/icons/icon-192.png', tag: 'bench-storage', data: { url: '/', onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: '/' } } } } },
          { ttlSeconds: 6 * 3_600, urgency: level === 'critical' ? 'high' : 'normal' },
        );
        sent ||= result.status === 'sent';
      }
    }
    return sent;
  }
}
