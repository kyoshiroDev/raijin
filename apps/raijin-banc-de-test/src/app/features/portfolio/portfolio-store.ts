import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { BenchApi, itemsOf } from '../../core/api/bench-api';
import { BenchEvents, type BenchEventSubscription } from '../../core/api/bench-events';
import { fetchTokenBriefs } from '../../core/api/token-briefs';
import {
  BOOK_LABEL,
  PAPER_BOOKS,
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
 * Virtual books, positions (with legs) and history of the owner (SIMULATION ONLY), read from the bench API.
 * Provided by PortfolioPage. SSE `paper` (ex-Realtime `paper-positions-live`: any position, leg or wallet change, and a
 * reconnection, reloads everything) and a periodic price refresh, cleaned up on destroy. Every write goes through an
 * API endpoint that re-checks everything.
 */
@Injectable()
export class PortfolioStore {
  private readonly api = inject(BenchApi);
  private readonly events = inject(BenchEvents);
  private stream: BenchEventSubscription | null = null;
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
      this.stream?.close();
      this.stream = null;
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

  /** Opens the SSE stream (`paper`) and the price timer. Idempotent. */
  listen(): void {
    if (this.stream) return;
    const onChange = () => void this.reloadAfterChange();
    this.stream = this.events.connect(['paper'], {
      onEvent: (event) => {
        if (event.type === 'paper.changed') onChange();
      },
      onReconnect: onChange,
    });
    this.timer = setInterval(() => void this.refreshPrices(), PRICE_REFRESH_MS);
  }

  /** Cancels a PENDING position (`POST /api/paper/positions/:id/cancel`, which re-checks the status). */
  async cancel(id: string): Promise<void> {
    const position = this._positions().find((p) => p.id === id);
    if (!position || position.status !== 'pending' || isArchivedBook(position.book) || this._busyId() !== null) return;
    this._busyId.set(id);
    this._feedback.set(null);
    try {
      try {
        await this.api.post(BENCH_ROUTES.paperPositionCancel, undefined, { params: { id } });
      } catch (error) {
        // Refused (already filled or expired, archived book): reload and say so.
        await this.reloadAfterChange();
        throw error;
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
      await this.api.post(BENCH_ROUTES.paperWalletReset, undefined, { params: { book } });
      this._confirmingBook.set(null);
      await this.reloadAfterChange();
      this._feedback.set({ kind: 'ok', text: PORTFOLIO_MSG.resetDone(book) });
    } catch {
      this._feedback.set({ kind: 'error', text: PORTFOLIO_MSG.resetFailed });
    } finally {
      this._resetting.set(false);
    }
  }

  /** Re-reads everything after a change (SSE event or reconnection, cancel, reset). Coalesces bursts. Best effort. */
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
    // Older archived books (half_x2_rest_x3, all_x2, young_*) are not read: only main, the test books and calm_all_x2 / frenzy_all_x2.
    const books = [...PAPER_BOOKS];
    const [wallets, positions] = await Promise.all([
      this.api.get(BENCH_ROUTES.paperWallets, { query: { books } }),
      // Most recent first, legs included.
      this.api.get(BENCH_ROUTES.paperPositions, { query: { books, limit: PAPER_FETCH_LIMIT } }),
    ]);
    this._wallets.set(parsePaperWallets(itemsOf(wallets)));
    this._positions.set(parsePaperPositions(itemsOf(positions)));
  }

  /**
   * Latest price of every mint with a pending or open position (`GET /api/tokens/briefs`: tokens.price_usd when
   * available, else the latest snapshot). Failures keep the previous prices.
   */
  private async refreshPrices(): Promise<void> {
    const mints = [...new Set(this._positions().filter((p) => p.status === 'open' || p.status === 'pending').map((p) => p.mint))];
    if (mints.length === 0) return;
    const prices = new Map(this._prices());
    try {
      readPrices(await fetchTokenBriefs(this.api, mints), prices, new Set());
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
