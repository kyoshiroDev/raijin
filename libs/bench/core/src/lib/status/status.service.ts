import { Inject, Injectable, Logger } from '@nestjs/common';
import { type BenchStatus, type BenchStorage, type JobHealth, type WalletStudyHealth } from '@raijin/bench-contracts';
import { BenchPrismaService } from '@raijin/bench-prisma';
import type { BenchSolana } from '@raijin/bench-solana';
import { assessStorage } from '@raijin/bench-verdicts';
import type { BenchConfig } from '../config/bench-config';
import { BENCH_CLOCK, BENCH_CONFIG, BENCH_SOLANA, BENCH_VERSION, type BenchClock } from '../config/tokens';
import { JobRunStore, jobHealthFrom } from '../jobs/job-runs.store';
import { BenchNotifier } from '../mode/bench-notifier';
import { BenchRedis } from '../redis/bench-redis';
import { errorCodeOf } from '../security/redact';

/**
 * `GET /api/status` (session) : mode, dépendances (base, Redis, Helius, push, e-mail), crédits Helius du jour,
 * wallet-study (`@raijin/bench-solana`), dernier run par job et taille de `raijin_bench`. Chaque bloc se
 * dégrade seul : une panne donne `down` / `null`, jamais une erreur 500 ni un détail technique.
 */
@Injectable()
export class BenchStatusService {
  private readonly logger = new Logger('BenchStatus');

  constructor(
    @Inject(BENCH_CONFIG) private readonly config: BenchConfig,
    @Inject(BENCH_CLOCK) private readonly clock: BenchClock,
    @Inject(BENCH_VERSION) private readonly version: string,
    @Inject(BENCH_SOLANA) private readonly solana: BenchSolana,
    private readonly prisma: BenchPrismaService,
    private readonly redis: BenchRedis,
    private readonly runs: JobRunStore,
    private readonly notifier: BenchNotifier,
  ) {}

  async liveness(): Promise<'ok' | 'degraded'> {
    return (await this.prisma.isHealthy()) ? 'ok' : 'degraded';
  }

  async status(): Promise<BenchStatus> {
    const [database, redis, jobs, storage, heliusCredits, walletStudy] = await Promise.all([
      this.prisma.isHealthy(),
      this.redis.ping(),
      this.jobs(),
      this.storage(),
      this.solana.heliusCredits().catch((error: unknown) => this.fail('crédits Helius', error, null)),
      this.walletStudy(),
    ]);
    return {
      mode: this.config.mode,
      version: this.version.slice(0, 40),
      dependencies: {
        database: database ? 'up' : 'down',
        redis: this.config.redisUrl ? (redis ? 'up' : 'down') : 'not_configured',
        helius: this.solana.service.heliusConfigured ? 'up' : 'not_configured',
        push: this.notifier.pushConfigured ? 'up' : 'not_configured',
        email: this.notifier.mailConfigured ? 'up' : 'not_configured',
      },
      helius_credits: heliusCredits,
      wallet_study: walletStudy,
      jobs,
      storage,
    };
  }

  private fail<T>(what: string, error: unknown, fallback: T): T {
    this.logger.warn(`Statut : ${what} indisponible (${errorCodeOf(error)})`);
    return fallback;
  }

  private async jobs(): Promise<JobHealth[]> {
    try {
      return await this.runs.health();
    } catch (error) {
      return this.fail('job_runs', error, jobHealthFrom([]));
    }
  }

  async storage(): Promise<BenchStorage | null> {
    try {
      const used = await this.prisma.databaseSizeBytes();
      const { ratio, level } = assessStorage(used, this.config.dbAllocatedBytes);
      return { used_bytes: used, allocated_bytes: this.config.dbAllocatedBytes, ratio, level, measured_at: this.clock().toISOString() };
    } catch (error) {
      return this.fail('taille de la base', error, null);
    }
  }

  private async walletStudy(): Promise<WalletStudyHealth> {
    try {
      return await this.solana.walletStudy.health();
    } catch (error) {
      return this.fail('wallet-study', error, { state: 'not_configured', credits_used: 0, credits_budget: 0 });
    }
  }
}
