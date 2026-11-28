import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TEST_PAPER_BOOKS, type PaperBook } from '@raijin/bench-contracts';
import { BENCH_CONFIG, BENCH_SOLANA, BenchEventBus, BenchJobRegistry, flatDetails, legacyEnv, type BenchConfig } from '@raijin/bench-core';
import { runBacktestRun, runPaperEngine, setRuntimeFetch } from '@raijin/bench-engine';
import { BenchSqlService } from '@raijin/bench-prisma';
import { withPublicBackoff, type BenchSolana } from '@raijin/bench-solana';

/** Carnets signalés au front après un pas du moteur paper (carnet principal + carnets de test actifs). */
export const LIVE_PAPER_BOOKS: readonly PaperBook[] = ['main', ...TEST_PAPER_BOOKS];

/**
 * Jobs de simulation portés (docs/BENCH.md §2–§3) : `paper-engine`, `backtest-run`, `backtest-nightly`. SIMULATION :
 * aucun ordre réel, aucune signature. Le moteur paper ne fait qu'avancer les positions déjà ouvertes (aucune
 * ouverture automatique ici : celles du scan passent par `autoPaperAllowed()`).
 */
@Injectable()
export class BenchTradingJobs implements OnModuleInit {
  private readonly logger = new Logger('BenchTrading');

  constructor(
    @Inject(BENCH_CONFIG) private readonly config: BenchConfig,
    @Inject(BENCH_SOLANA) private readonly solana: BenchSolana,
    private readonly registry: BenchJobRegistry,
    private readonly sql: BenchSqlService,
    private readonly events: BenchEventBus,
  ) {}

  onModuleInit(): void {
    setRuntimeFetch(withPublicBackoff((input, init) => fetch(input, init), this.solana.service.config, this.solana.backoff));
    const env = legacyEnv(this.config);
    this.registry.register('paper-engine', async () => {
      const stats = await runPaperEngine({ db: this.sql.db, env });
      if (stats.filled + stats.closed + stats.legs + stats.moved + stats.expired > 0) this.paperChanged();
      return flatDetails(stats);
    });
    this.registry.register('backtest-run', async () => {
      const out = await runBacktestRun({ db: this.sql.db });
      const run = out['run'];
      if (typeof run === 'number') await this.backtestProgress(run);
      return flatDetails(out);
    });
    // Ex-pg_cron `raijin-backtest-nightly` (03:40 UTC) : `select backtest_enqueue_nightly()`, inchangé.
    this.registry.register('backtest-nightly', async () => {
      const { data, error } = await this.sql.db.rpc('backtest_enqueue_nightly');
      if (error) throw new Error(`backtest_enqueue_nightly: ${error.code ?? 'erreur'}`);
      return { run: typeof data === 'number' ? data : null };
    });
  }

  /** Remplace le canal Realtime `paper-positions-live` : simple signal, le front recharge. */
  paperChanged(book?: PaperBook, positionId: string | null = null): void {
    for (const b of book ? [book] : LIVE_PAPER_BOOKS) this.events.publish({ type: 'paper.changed', book: b, position_id: positionId });
  }

  private async backtestProgress(runId: number): Promise<void> {
    const { data } = await this.sql.db.from('backtest_runs').select('id, status, progress').eq('id', runId).maybeSingle();
    const row = data as { id: number; status: 'queued' | 'running' | 'done' | 'failed'; progress: number } | null;
    if (!row) return;
    this.events.publish({ type: 'backtest.progress', run_id: String(row.id), status: row.status, progress: Math.max(0, Math.min(1, Number(row.progress) || 0)) });
  }
}
