import { Injectable, computed, inject, signal } from '@angular/core';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { BenchApi } from '../api/bench-api';

/** Rates are re-read at most every 5 minutes. */
export const MARKET_CONTEXT_TTL_MS = 5 * 60_000;

export interface MarketRates {
  /** USD per SOL. */
  solUsd: number;
  /** USD per EUR. */
  eurUsd: number;
}

const positive = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

/** Untrusted row → rates, or null when either value is missing/invalid. */
export function parseMarketRates(row: unknown): MarketRates | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as { sol_usd?: unknown; eur_usd?: unknown };
  const solUsd = positive(r.sol_usd);
  const eurUsd = positive(r.eur_usd);
  return solUsd !== null && eurUsd !== null ? { solUsd, eurUsd } : null;
}

/**
 * SOL/USD and EUR/USD rates recorded by the latest scan run (`GET /api/market/rates`, read from
 * scan_runs by the bench API), used only to show a € equivalent next to SOL amounts. The browser
 * never calls a price API. Any failure (route not deployed yet, network, null
 * values) simply leaves `eurPerSol` null: the UI then shows SOL without €.
 */
@Injectable({ providedIn: 'root' })
export class MarketContext {
  private readonly api = inject(BenchApi);

  private readonly _rates = signal<MarketRates | null>(null);
  private loadedAt: number | null = null;
  private pending: Promise<void> | null = null;
  /** Incremented by reset() so a slow load from a previous session never writes. */
  private generation = 0;

  readonly rates = this._rates.asReadonly();
  /** € per SOL = sol_usd / eur_usd; null when unknown. */
  readonly eurPerSol = computed(() => {
    const r = this._rates();
    return r ? r.solUsd / r.eurUsd : null;
  });

  /** Reads the latest rates unless they were read less than 5 minutes ago (or a read is in flight). */
  load(now = Date.now()): Promise<void> {
    if (this.pending) return this.pending;
    if (this.loadedAt !== null && now - this.loadedAt < MARKET_CONTEXT_TTL_MS) return Promise.resolve();
    const gen = this.generation;
    this.pending = this.fetch(gen, now).finally(() => {
      if (gen === this.generation) this.pending = null;
    });
    return this.pending;
  }

  reset(): void {
    this.generation++;
    this.pending = null;
    this.loadedAt = null;
    this._rates.set(null);
  }

  private async fetch(gen: number, now: number): Promise<void> {
    let rates: MarketRates | null;
    try {
      const body = await this.api.get(BENCH_ROUTES.marketRates);
      rates = typeof body === 'object' && body !== null ? parseMarketRates((body as { rates?: unknown }).rates) : null;
    } catch {
      rates = null;
    }
    if (gen !== this.generation) return;
    this.loadedAt = now;
    this._rates.set(rates);
  }
}
