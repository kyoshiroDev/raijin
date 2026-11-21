import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SUPABASE } from '../../core/supabase/supabase-client';
import {
  BOOK_LABEL,
  PAPER_POSITION_COLUMNS,
  PAPER_BOOKS,
  PAPER_WALLET_COLUMNS,
  TEST_BOOKS,
  isArchivedBook,
  isPaperBook,
  parsePaperPositions,
  parsePaperWallets,
  toNumber,
  type PaperBook,
  type PaperPosition,
  type PaperWallet,
} from '../../shared/models/paper';
import { availableBooks, buildBookView, type BookView } from './paper-book';
import { stopSlippageByBook, type StopSlippage } from './stop-slippage';

/** Most recent positions read (history included). */
export const PAPER_FETCH_LIMIT = 500;
/** Live prices are re-read this often while the screen is open (the scan runs every 2 min). */
export const PRICE_REFRESH_MS = 60_000;

export const PORTFOLIO_MSG = {
  loadFailed: 'Impossible de charger ton portefeuille virtuel. Réessaie dans un instant.',
  cancelFailed: 'Impossible d’annuler cette position. Réessaie dans un instant.',
  resetFailed: 'Impossible de réinitialiser ce portefeuille. Réessaie dans un instant.',
  resetDone: (book: PaperBook) => `Portefeuille « ${BOOK_LABEL[book]} » réinitialisé à 1 SOL virtuel.`,
} as const;

export interface Feedback {
  kind: 'ok' | 'error';
  text: string;
}

/**
 * Virtual books, positions (with legs) and history of the signed-in user (SIMULATION ONLY; owner-only RLS).
 * Provided by PortfolioPage. Realtime on paper_positions + paper_legs (wallets reloaded with them; not published) and a periodic price refresh, cleaned up
 * on destroy. Every write goes through an RPC.
 */
@Injectable()
export class PortfolioStore {
  private readonly supabase = inject(SUPABASE);
  private channel: RealtimeChannel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reloading: Promise<void> | null = null;
  private reloadAgain = false;

  private readonly _wallets = signal<PaperWallet[]>([]);
  private readonly _positions = signal<PaperPosition[]>([]);
  private readonly _prices = signal<ReadonlyMap<string, number>>(new Map());
  private readonly _selected = signal<PaperBook>('main');
  private readonly _loading = signal(false);
  private readonly _loaded = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _busyId = signal<string | null>(null);
  private readonly _confirmingBook = signal<PaperBook | null>(null);
  private readonly _resetting = signal(false);
  private readonly _feedback = signal<Feedback | null>(null);

  readonly wallets = this._wallets.asReadonly();
  readonly positions = this._positions.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly error = this._error.asReadonly();
  /** Id of the position being cancelled. */
  readonly busyId = this._busyId.asReadonly();
  /** Book whose reset is awaiting confirmation (null = no confirmation shown). */
  readonly confirmingBook = this._confirmingBook.asReadonly();
  readonly resetting = this._resetting.asReadonly();
  readonly feedback = this._feedback.asReadonly();

  readonly books = computed(() => availableBooks(this._wallets(), this._positions()));
  /** Parallel comparison books exist: the selector is shown. */
  readonly hasParallel = computed(() => this.books().length > 1);
  readonly selectedBook = computed<PaperBook>(() => (this.books().includes(this._selected()) ? this._selected() : 'main'));
  readonly view = computed<BookView>(() => buildBookView(this.selectedBook(), this._wallets(), this._positions(), this._prices()));
  /** The selected book is archived: history only (no reset, no cancel). */
  readonly selectedArchived = computed(() => isArchivedBook(this.selectedBook()));
  /** The three test books side by side (those that exist, in TEST_BOOKS order); null under two. */
  readonly testComparison = computed<BookView[] | null>(() => this.compare(TEST_BOOKS));

  /** Exit slippage on stops, one entry per available book (computed from the loaded legs). */
  readonly stopSlippage = computed<StopSlippage[]>(() => stopSlippageByBook(this._positions(), this.books()));

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.channel) void this.supabase.removeChannel(this.channel);
      this.channel = null;
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
    });
  }

  /** Views of the `wanted` books that exist, in that order; null when fewer than two exist (nothing to compare). */
  private compare(wanted: readonly PaperBook[]): BookView[] | null {
    const present = wanted.filter((b) => this.books().includes(b));
    if (present.length < 2) return null;
    return present.map((b) => buildBookView(b, this._wallets(), this._positions(), this._prices()));
  }

  selectBook(book: PaperBook): void {
    if (isPaperBook(book)) this._selected.set(book);
  }

  async load(): Promise<void> {
    if (this._loading()) return;
    this._loading.set(true);
    this._error.set(null);
    try {
      await this.loadAll();
      await this.refreshPrices();
    } catch {
      this._error.set(PORTFOLIO_MSG.loadFailed);
    } finally {
      this._loading.set(false);
      this._loaded.set(true);
    }
  }

  /** Opens the Realtime subscription on own positions, legs and wallets (RLS) and the price timer. Idempotent. */
  listen(): void {
    if (this.channel) return;
    const onChange = () => void this.reloadAfterChange();
    this.channel = this.supabase
      .channel('paper-positions-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'paper_positions' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'paper_legs' }, onChange)
      .subscribe();
    this.timer = setInterval(() => void this.refreshPrices(), PRICE_REFRESH_MS);
  }

  /** Cancels a PENDING position (the RPC re-checks ownership and status). */
  async cancel(id: string): Promise<void> {
    const position = this._positions().find((p) => p.id === id);
    if (!position || position.status !== 'pending' || isArchivedBook(position.book) || this._busyId() !== null) return;
    this._busyId.set(id);
    this._feedback.set(null);
    try {
      const { data, error } = await this.supabase.rpc('paper_cancel_position', { p_id: id });
      // false = not cancelled (already filled, expired or not ours): reload and say so.
      if (error || data === false) {
        await this.reloadAfterChange();
        throw error ?? new Error('not cancelled');
      }
      await this.reloadAfterChange();
    } catch {
      this._feedback.set({ kind: 'error', text: PORTFOLIO_MSG.cancelFailed });
    } finally {
      this._busyId.set(null);
    }
  }

  /** Step 1 of a reset: shows the confirmation for `book` (never an archived book). Nothing is sent. */
  requestReset(book: PaperBook): void {
    if (!isPaperBook(book) || isArchivedBook(book)) return;
    this._feedback.set(null);
    this._confirmingBook.set(book);
  }

  dismissReset(): void {
    this._confirmingBook.set(null);
  }

  /** Step 2: only after requestReset(); resets exactly the book being confirmed. */
  async confirmReset(): Promise<void> {
    const book = this._confirmingBook();
    if (book === null || isArchivedBook(book) || this._resetting()) return;
    this._resetting.set(true);
    try {
      const { error } = await this.supabase.rpc('paper_reset_wallet', { p_book: book });
      if (error) throw error;
      this._confirmingBook.set(null);
      await this.reloadAfterChange();
      this._feedback.set({ kind: 'ok', text: PORTFOLIO_MSG.resetDone(book) });
    } catch {
      this._feedback.set({ kind: 'error', text: PORTFOLIO_MSG.resetFailed });
    } finally {
      this._resetting.set(false);
    }
  }

  /** Re-reads everything after a change (Realtime event, cancel, reset). Coalesces bursts. Best effort. */
  private async reloadAfterChange(): Promise<void> {
    if (this.reloading) {
      this.reloadAgain = true;
      return this.reloading;
    }
    this.reloading = (async () => {
      do {
        this.reloadAgain = false;
        try {
          await this.loadAll();
          await this.refreshPrices();
        } catch {
          // Keep the current state; the next event or refresh will catch up.
        }
      } while (this.reloadAgain);
    })();
    try {
      await this.reloading;
    } finally {
      this.reloading = null;
    }
  }

  private async loadAll(): Promise<void> {
    const [wallets, positions] = await Promise.all([
      // Older archived books (half_x2_rest_x3, all_x2, young_*) are not read: only main, the test books and calm_all_x2 / frenzy_all_x2.
      this.supabase.from('paper_wallets').select(PAPER_WALLET_COLUMNS).in('book', PAPER_BOOKS),
      this.supabase
        .from('paper_positions')
        .select(PAPER_POSITION_COLUMNS)
        .in('book', PAPER_BOOKS)
        .order('created_at', { ascending: false })
        .limit(PAPER_FETCH_LIMIT),
    ]);
    if (wallets.error) throw wallets.error;
    if (positions.error) throw positions.error;
    this._wallets.set(parsePaperWallets(wallets.data));
    this._positions.set(parsePaperPositions(positions.data));
  }

  /**
   * Latest price of every mint with a pending or open position: public.tokens.price_usd when available,
   * else the latest token_snapshots row. Failures keep the previous prices.
   */
  private async refreshPrices(): Promise<void> {
    const mints = [...new Set(this._positions().filter((p) => p.status === 'open' || p.status === 'pending').map((p) => p.mint))];
    if (mints.length === 0) return;
    const prices = new Map(this._prices());
    try {
      const { data, error } = await this.supabase.from('tokens').select('mint,price_usd').in('mint', mints);
      const fresh = new Set<string>();
      if (!error) readPrices(data, prices, fresh);
      const missing = mints.filter((m) => !fresh.has(m));
      await Promise.all(
        missing.map(async (mint) => {
          const snap = await this.supabase
            .from('token_snapshots')
            .select('mint,price_usd')
            .eq('mint', mint)
            .order('captured_at', { ascending: false })
            .limit(1);
          if (!snap.error) readPrices(snap.data, prices, new Set());
        }),
      );
    } catch {
      // keep what we have
    }
    this._prices.set(prices);
  }
}

/** Copies valid `{ mint, price_usd > 0 }` rows into `into`, recording the mints found in `found`. */
function readPrices(data: unknown, into: Map<string, number>, found: Set<string>): void {
  if (!Array.isArray(data)) return;
  for (const row of data) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const price = toNumber(r['price_usd']);
    if (typeof r['mint'] === 'string' && price !== null && price > 0) {
      into.set(r['mint'], price);
      found.add(r['mint']);
    }
  }
}
