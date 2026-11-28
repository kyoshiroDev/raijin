import { UpstreamError, toUpstreamError, type UpstreamId } from './errors';
import { SYSTEM_CLOCK, type Clock } from './ports';
import { NOOP_USAGE_RECORDER, classifyUpstreamError, type SourceUsageRecorder } from './usage';

export interface GateOptions {
  readonly source: UpstreamId;
  /** Débit soutenu autorisé (requêtes par seconde, fractions acceptées : 0,5 = 1 toutes les 2 s). */
  readonly ratePerSecond: number;
  /** Rafale maximale (jetons du seau). Défaut : max(1, ⌈débit⌉). */
  readonly burst?: number;
  /** Taille maximale de la file d'attente ; au-delà, échec immédiat `queue_full`. */
  readonly maxQueue: number;
  /** Tentatives au total (1 = aucun rejeu). */
  readonly maxAttempts: number;
  /** Base du backoff exponentiel (ms) ; gigue aléatoire ajoutée dans [0, base]. */
  readonly backoffBaseMs: number;
  /** `Retry-After` respecté jusqu'à cette valeur (ms). */
  readonly maxRetryAfterMs: number;
  /** Échecs consécutifs avant ouverture du disjoncteur. */
  readonly breakerThreshold: number;
  /** Durée d'ouverture du disjoncteur avant un essai (ms). */
  readonly breakerCooldownMs: number;
}

export interface GateDeps {
  readonly clock?: Clock;
  /** Aléa de la gigue (injectable pour des tests déterministes). */
  readonly random?: () => number;
  /** Compteurs d'appels (chaque tentative, rejeux compris) et de refus ; aucun par défaut. */
  readonly usage?: SourceUsageRecorder;
}

interface Waiter {
  resolve: () => void;
  reject: (error: UpstreamError) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * File de débit maison d'une source (ARCHITECTURE.md §9.1) : seau à jetons + file FIFO bornée,
 * rejeux avec backoff exponentiel + gigue (réseau, délai, 429, 5xx), disjoncteur simple
 * (N échecs consécutifs → ouvert pendant la durée de refroidissement → un essai).
 */
export class UpstreamGate {
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly usage: SourceUsageRecorder;
  private readonly capacity: number;
  private tokens: number;
  private lastRefill: number;
  private readonly queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  private breaker: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    readonly options: GateOptions,
    deps: GateDeps = {},
  ) {
    if (!(options.ratePerSecond > 0)) throw new RangeError('Débit invalide.');
    this.clock = deps.clock ?? SYSTEM_CLOCK;
    this.random = deps.random ?? Math.random;
    this.usage = deps.usage ?? NOOP_USAGE_RECORDER;
    this.capacity = Math.max(1, options.burst ?? Math.ceil(options.ratePerSecond));
    this.tokens = this.capacity;
    this.lastRefill = this.clock.now();
  }

  get source(): UpstreamId {
    return this.options.source;
  }

  /** État du disjoncteur (supervision). */
  get breakerState(): BreakerState {
    this.refreshBreaker();
    return this.breaker;
  }

  /**
   * Exécute `task` sous la file de débit, avec rejeux et disjoncteur. Chaque tentative est comptée
   * (`usage.recordCall` : issue, latence) ; un refus avant requête l'est par `usage.recordRejection`.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let isTrial: boolean;
    try {
      isTrial = this.enterBreaker();
    } catch (error) {
      this.usage.recordRejection(this.source, 'circuit_open');
      throw error;
    }
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await this.acquire(signal);
        } catch (error) {
          // Refus avant requête : file pleine ou annulation pendant l'attente.
          this.usage.recordRejection(this.source, (error as UpstreamError).kind === 'queue_full' ? 'queue_full' : 'aborted');
          throw error;
        }
        const startedAt = this.clock.now();
        try {
          const result = await task();
          this.usage.recordCall(this.source, 'success', this.clock.now() - startedAt);
          this.onSuccess();
          return result;
        } catch (raw) {
          const error = toUpstreamError(this.source, raw);
          this.recordError(error, this.clock.now() - startedAt);
          const canRetry = error.retryable && attempt < this.options.maxAttempts && !signal?.aborted;
          if (!canRetry) {
            if (error.countsAsFailure) this.onFailure();
            throw error;
          }
          await this.sleep(this.retryDelay(error, attempt), signal);
        }
      }
    } finally {
      if (isTrial) this.trialInFlight = false;
    }
  }

  private recordError(error: UpstreamError, latencyMs: number): void {
    const classified = classifyUpstreamError(error);
    if (classified.kind === 'call') this.usage.recordCall(this.source, classified.outcome, latencyMs);
    else this.usage.recordRejection(this.source, classified.reason);
  }

  private retryDelay(error: UpstreamError, attempt: number): number {
    if (error.retryAfterMs !== null) return Math.min(error.retryAfterMs, this.options.maxRetryAfterMs);
    const base = this.options.backoffBaseMs;
    return base * 2 ** (attempt - 1) + Math.floor(this.random() * base);
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new UpstreamError(this.source, 'aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // --- Disjoncteur ---------------------------------------------------------------------------

  private refreshBreaker(): void {
    if (this.breaker === 'open' && this.clock.now() - this.openedAt >= this.options.breakerCooldownMs) {
      this.breaker = 'half_open';
    }
  }

  /** Renvoie vrai si l'appel est l'essai unique d'un disjoncteur à demi ouvert. */
  private enterBreaker(): boolean {
    this.refreshBreaker();
    if (this.breaker === 'open') throw new UpstreamError(this.source, 'circuit_open');
    if (this.breaker === 'half_open') {
      if (this.trialInFlight) throw new UpstreamError(this.source, 'circuit_open');
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.breaker = 'closed';
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.breaker === 'half_open' || this.consecutiveFailures >= this.options.breakerThreshold) {
      this.breaker = 'open';
      this.openedAt = this.clock.now();
    }
  }

  // --- Seau à jetons + file FIFO ----------------------------------------------------------------

  private refill(): void {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1_000) * this.options.ratePerSecond);
    this.lastRefill = now;
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new UpstreamError(this.source, 'aborted'));
    this.refill();
    if (this.queue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.options.maxQueue) {
      return Promise.reject(new UpstreamError(this.source, 'queue_full'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new UpstreamError(this.source, 'aborted'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      const waiter = this.queue.shift() as Waiter;
      this.tokens -= 1;
      if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.resolve();
    }
    if (this.queue.length === 0) return;
    const waitMs = Math.ceil(((1 - this.tokens) / this.options.ratePerSecond) * 1_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, Math.max(1, waitMs));
    unrefTimer(this.timer);
  }
}
