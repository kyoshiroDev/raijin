import {
  HISTORY_CREDITS_PER_PAGE,
  HeliusMethodUnavailableError,
  SILENT_LOGGER,
  SYSTEM_CLOCK,
  UpstreamError,
  type CacheStore,
  type Clock,
  type HistoryPage,
  type HistoryPageOptions,
  type PrefixedRedisCreditBudget,
  type SolanaDataService,
  type SolanaLogger,
} from '@raijin/api-solana';
import type { WalletStudyHealth, WalletStudyState } from '@raijin/bench-contracts';

/** Raison d'une page non obtenue (dégradation propre : jamais d'exception vers le job). */
export type WalletStudyUnavailableReason = Exclude<WalletStudyState, 'active'> | 'upstream';

export type WalletStudyPageResult =
  | { readonly status: 'ok'; readonly page: HistoryPage }
  | { readonly status: 'unavailable'; readonly reason: WalletStudyUnavailableReason };

/** Indicateur « méthode indisponible » (clé de cache, préfixée par le stockage du banc). */
export const WALLET_STUDY_UNAVAILABLE_FLAG = 'helius:wallet-study:method-unavailable';

export interface WalletStudySourceDeps {
  readonly service: Pick<SolanaDataService, 'transactionHistoryPage' | 'heliusConfigured'>;
  readonly budget: Pick<PrefixedRedisCreditBudget, 'used' | 'limit'>;
  /** Stockage de l'indicateur (Redis du banc, partagé entre processus). */
  readonly flags: CacheStore;
  readonly clock?: Clock;
  readonly logger?: SolanaLogger;
}

function secondsUntilNextUtcDay(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((next.getTime() - now) / 1_000));
}

/**
 * Source d'historique de wallet-study (BENCH.md §9 P1) : Helius `getTransactionsForAddress`, voie de crédits
 * `wallet` plafonnée par `BENCH_WALLET_STUDY_DAILY_CREDITS` (dans le budget de 10 000/jour du banc, les
 * verdicts restent prioritaires). Si l'offre Helius ne propose pas la méthode, l'étude se **désactive**
 * jusqu'au jour UTC suivant (nouvel essai alors), le signale une fois dans les journaux et dans la santé
 * (`wallet_study.state = 'method_unavailable'`). Lecture seule.
 */
export class BenchWalletStudySource {
  private readonly clock: Clock;
  private readonly logger: SolanaLogger;
  /** Fin de désactivation connue localement (ms epoch). */
  private disabledUntil = 0;

  constructor(private readonly deps: WalletStudySourceDeps) {
    this.clock = deps.clock ?? SYSTEM_CLOCK;
    this.logger = deps.logger ?? SILENT_LOGGER;
  }

  /** Une page d'historique, ou la raison de son absence. */
  async page(address: string, options: HistoryPageOptions = {}): Promise<WalletStudyPageResult> {
    const state = await this.state();
    if (state !== 'active') return { status: 'unavailable', reason: state };
    try {
      return { status: 'ok', page: await this.deps.service.transactionHistoryPage(address, options) };
    } catch (error) {
      if (error instanceof HeliusMethodUnavailableError) {
        await this.disable();
        return { status: 'unavailable', reason: 'method_unavailable' };
      }
      if (error instanceof UpstreamError && error.kind === 'budget_exhausted') return { status: 'unavailable', reason: 'budget_exhausted' };
      if (error instanceof UpstreamError && error.kind === 'not_configured') return { status: 'unavailable', reason: 'not_configured' };
      if (error instanceof RangeError) throw error;
      return { status: 'unavailable', reason: 'upstream' };
    }
  }

  /** État courant (santé, et garde avant chaque page). */
  async state(): Promise<WalletStudyState> {
    if (!this.deps.service.heliusConfigured) return 'not_configured';
    if (await this.isDisabled()) return 'method_unavailable';
    const remaining = this.deps.budget.limit('wallet') - (await this.deps.budget.used('wallet'));
    return remaining < HISTORY_CREDITS_PER_PAGE ? 'budget_exhausted' : 'active';
  }

  /** Bloc `wallet_study` de `GET /api/status` (`@raijin/bench-contracts`). */
  async health(): Promise<WalletStudyHealth> {
    return {
      state: await this.state(),
      credits_used: await this.deps.budget.used('wallet'),
      credits_budget: this.deps.budget.limit('wallet'),
    };
  }

  private async isDisabled(): Promise<boolean> {
    const now = this.clock.now();
    if (this.disabledUntil > now) return true;
    const flag = await this.deps.flags.get(WALLET_STUDY_UNAVAILABLE_FLAG).catch(() => null);
    if (flag === null || !/^\d{1,15}$/.test(flag) || Number(flag) <= now) return false;
    this.disabledUntil = Number(flag);
    return true;
  }

  private async disable(): Promise<void> {
    const now = this.clock.now();
    const ttl = secondsUntilNextUtcDay(now);
    this.disabledUntil = now + ttl * 1_000;
    this.logger.warn('wallet_study_disabled', { reason: 'method_unavailable', retryInSeconds: ttl });
    await this.deps.flags.set(WALLET_STUDY_UNAVAILABLE_FLAG, String(this.disabledUntil), ttl).catch(() => undefined);
  }
}
