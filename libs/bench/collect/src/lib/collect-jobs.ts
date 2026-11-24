import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { tokenRowSchema } from '@raijin/bench-contracts';
import {
  BENCH_CONFIG,
  BENCH_SOLANA,
  BenchEventBus,
  BenchJobRegistry,
  BenchModeService,
  BenchNotifier,
  flatDetails,
  legacyEnv,
  type BenchConfig,
} from '@raijin/bench-core';
import {
  runEnrichTokens,
  runLabelOutcomes,
  runScanTokens,
  runWalletStudyCollect,
  setRuntimeFetch,
  type BenchDb,
  type ScanPushPort,
} from '@raijin/bench-engine';
import { BenchSqlService } from '@raijin/bench-prisma';
import { withPublicBackoff, type BenchSolana } from '@raijin/bench-solana';
import { TOKEN_COLUMNS } from './token-columns';

/** Durée de conservation d'une notification par le service push (même valeur que l'Edge Function : 1 h). */
const PUSH_TTL_SECONDS = 3_600;
/** Lignes `tokens` diffusées en SSE après un scan ou un enrichissement (le front n'en affiche pas plus). */
export const SSE_TOKENS_MAX = 300;

/**
 * Envoi push du scan porté par `BenchNotifier` (`@raijin/server-push`, paire VAPID du banc). `null` si le push
 * n'est pas configuré **ou** en mode ombre : le code porté se comporte alors comme sans clés VAPID (aucune alerte).
 */
export function scanPushPort(notifier: BenchNotifier, mode: BenchModeService): ScanPushPort | null {
  if (!notifier.pushConfigured || !mode.notificationsAllowed()) return null;
  return {
    async send(sub, payload) {
      const result = await notifier.sendBenchPush(sub, JSON.parse(payload) as object, { ttlSeconds: PUSH_TTL_SECONDS, urgency: 'normal' });
      return { ok: result.status === 'sent', gone: result.status === 'gone' };
    },
  };
}

/**
 * Jobs de collecte portés (docs/BENCH.md §2–§3) : `scan-tokens`, `enrich-tokens`, `label-outcomes`,
 * `wallet-study-collect`. Corps : `@raijin/bench-engine` (code des Edge Functions) ; base : `BenchSqlService`
 * (`raijin_bench`) ; HTTP : `fetch` enveloppé par le recul sur 429 de `@raijin/bench-solana`.
 */
@Injectable()
export class BenchCollectJobs implements OnModuleInit {
  private readonly logger = new Logger('BenchCollect');

  constructor(
    @Inject(BENCH_CONFIG) private readonly config: BenchConfig,
    @Inject(BENCH_SOLANA) private readonly solana: BenchSolana,
    private readonly registry: BenchJobRegistry,
    private readonly sql: BenchSqlService,
    private readonly events: BenchEventBus,
    private readonly mode: BenchModeService,
    private readonly notifier: BenchNotifier,
  ) {}

  onModuleInit(): void {
    setRuntimeFetch(withPublicBackoff((input, init) => fetch(input, init), this.solana.service.config, this.solana.backoff));
    const env = legacyEnv(this.config);
    this.registry.register('scan-tokens', async (ctx) => {
      const stats = await runScanTokens({
        db: this.sql.db,
        env,
        push: scanPushPort(this.notifier, this.mode),
        autoPaperAllowed: () => this.mode.autoPaperAllowed(),
      });
      await this.publishTokens(this.sql.db, ctx.startedAt);
      return flatDetails(stats);
    });
    this.registry.register('enrich-tokens', async (ctx) => {
      const stats = await runEnrichTokens({ db: this.sql.db, env });
      await this.publishTokens(this.sql.db, ctx.startedAt);
      return flatDetails(stats);
    });
    this.registry.register('label-outcomes', async () => flatDetails(await runLabelOutcomes({ db: this.sql.db })));
    this.registry.register('wallet-study-collect', async () =>
      flatDetails(await runWalletStudyCollect({ db: this.sql.db, history: this.solana.walletStudy })),
    );
  }

  /** Remplace le canal Realtime `tokens-live` : un `token.upsert` par ligne écrite depuis le début du job. */
  async publishTokens(db: BenchDb, since: Date): Promise<number> {
    const { data, error } = await db
      .from('tokens')
      .select(TOKEN_COLUMNS)
      .gte('updated_at', since.toISOString())
      .order('updated_at', { ascending: false })
      .limit(SSE_TOKENS_MAX);
    if (error) {
      this.logger.warn(`Diffusion SSE des tokens impossible (${error.code ?? 'erreur'})`);
      return 0;
    }
    let sent = 0;
    for (const row of (data ?? []) as unknown[]) {
      const token = tokenRowSchema.safeParse(row);
      if (!token.success) continue;
      this.events.publish({ type: 'token.upsert', token: token.data });
      sent++;
    }
    return sent;
  }
}
