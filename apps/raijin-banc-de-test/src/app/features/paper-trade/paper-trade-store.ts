import { Injectable, computed, inject, signal } from '@angular/core';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { BenchApi, itemsOf } from '../../core/api/bench-api';
import { PAPER_ERRORS, committedSol, defaultWallet, isInsufficientBalanceError, parsePaperWallet, roundSol, toNumber } from '@raijin/bench-web-logic';
import { openPositionParams, validateDraft, type PaperDraft } from '@raijin/bench-web-logic/paper-trade';

export type SubmitState = 'idle' | 'pending' | 'done' | 'error';

/**
 * Trade sheet state (SIMULATION ONLY). Provided by PaperTradePanel, i.e. created when the sheet opens.
 * Reads the main virtual wallet and its pending reservations (bench API), opens the position through
 * `POST /api/paper/positions`, which re-checks everything (available = balance − reserved pending, backend rule).
 */
@Injectable()
export class PaperTradeStore {
  private readonly api = inject(BenchApi);

  private readonly _balance = signal<number | null>(null);
  private readonly _committed = signal(0);
  private readonly _loadError = signal(false);
  private readonly _state = signal<SubmitState>('idle');
  private readonly _error = signal<string | null>(null);

  /** Virtual balance of the main book (null while unknown). */
  readonly balance = this._balance.asReadonly();
  /** SOL reserved by the pending positions of the main book. */
  readonly committed = this._committed.asReadonly();
  /** Balance minus the pending reservations; null while unknown. */
  readonly available = computed(() => {
    const b = this._balance();
    return b === null ? null : Math.max(0, roundSol(b - this._committed()));
  });
  readonly loadError = this._loadError.asReadonly();
  readonly state = this._state.asReadonly();
  readonly error = this._error.asReadonly();

  async load(): Promise<void> {
    this._loadError.set(false);
    try {
      const [wallets, pending] = await Promise.all([
        this.api.get(BENCH_ROUTES.paperWallets, { query: { books: ['main'] } }),
        this.api.get(BENCH_ROUTES.paperPositions, { query: { books: ['main'], status: 'pending', limit: 500 } }),
      ]);
      const row = itemsOf(wallets).find((w) => typeof w === 'object' && w !== null && (w as { book?: unknown }).book === 'main');
      // No row yet: the first position creates a fresh 1 SOL wallet.
      const balance = (row === undefined ? defaultWallet('main') : parsePaperWallet(row))?.balance_sol ?? null;
      if (balance === null) throw new Error('wallet');
      this._committed.set(committedSol(parsePending(itemsOf(pending))));
      this._balance.set(balance);
    } catch {
      this._loadError.set(true);
    }
  }

  /** Opens the position. Returns true on success. Errors are generic (never the server text). */
  async submit(draft: PaperDraft, mint: string): Promise<boolean> {
    if (this._state() === 'pending') return false;
    if (Object.keys(validateDraft(draft, this.available())).length > 0) return false;
    this._state.set('pending');
    this._error.set(null);
    try {
      await this.api.post(BENCH_ROUTES.paperPositions, openPositionParams(draft, mint));
      this._state.set('done');
      return true;
    } catch (error) {
      this._error.set(isInsufficientBalanceError(error) ? PAPER_ERRORS.insufficient : PAPER_ERRORS.rejected);
      this._state.set('error');
      return false;
    }
  }
}

/** Minimal parse of the pending rows: only what the reservation needs. */
function parsePending(rows: unknown): { status: 'pending'; stake_sol: number }[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown) => {
    const stake = typeof row === 'object' && row !== null ? toNumber((row as Record<string, unknown>)['stake_sol']) : null;
    return stake !== null && stake > 0 ? [{ status: 'pending' as const, stake_sol: stake }] : [];
  });
}
