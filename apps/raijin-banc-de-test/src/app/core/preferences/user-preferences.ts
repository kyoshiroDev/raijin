import { Injectable, inject, signal } from '@angular/core';
import { DEFAULT_PAPER_SL_PCT, isValidSlPct, parseSlPct } from '../../shared/models/paper';
import { DEFAULT_STAKE_SOL, isValidStake, parseStakeValue } from '../../shared/utils/stake';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { BenchApi } from '../api/bench-api';

/**
 * Per-user preferences needed outside the settings page: the usual stake in SOL (round-trip estimate, paper trade
 * stake) and the default paper stop % (the paper strategy is always « tout à ×2 »). Read once from the bench API
 * (`GET /api/settings/preferences`) when the signed-in shell starts; reset when it is destroyed (sign-out). Defaults
 * when the read fails.
 */
@Injectable({ providedIn: 'root' })
export class UserPreferences {
  private readonly api = inject(BenchApi);

  private readonly _stakeSol = signal(DEFAULT_STAKE_SOL);
  private readonly _paperSlPct = signal(DEFAULT_PAPER_SL_PCT);
  /** Incremented by reset() so a slow load for a previous session never overwrites the state. */
  private generation = 0;

  readonly stakeSol = this._stakeSol.asReadonly();
  readonly paperSlPct = this._paperSlPct.asReadonly();

  async load(): Promise<void> {
    const gen = ++this.generation;
    try {
      const data = await this.api.get(BENCH_ROUTES.preferences);
      const row: Record<string, unknown> = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
      if (gen !== this.generation) return;
      this._stakeSol.set(parseStakeValue(row['stake_sol']) ?? DEFAULT_STAKE_SOL);
      this._paperSlPct.set(parseSlPct(row['paper_sl_pct']) ?? DEFAULT_PAPER_SL_PCT);
    } catch {
      // Keep the current values (defaults): the estimates stay usable.
    }
  }

  /** Called by the settings page after a successful load or save. Invalid values are ignored. */
  setStake(value: number): void {
    if (!isValidStake(value)) return;
    this.generation++; // a pending load must not overwrite a fresher value
    this._stakeSol.set(value);
  }

  /** Called by the settings page after a successful load or save. Invalid values are ignored. */
  setPaperSlPct(slPct: number): void {
    if (!isValidSlPct(slPct)) return;
    this.generation++;
    this._paperSlPct.set(slPct);
  }

  reset(): void {
    this.generation++;
    this._stakeSol.set(DEFAULT_STAKE_SOL);
    this._paperSlPct.set(DEFAULT_PAPER_SL_PCT);
  }
}
