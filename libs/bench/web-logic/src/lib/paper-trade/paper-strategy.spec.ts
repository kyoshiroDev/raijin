import { paperOpenRequestSchema } from '@raijin/bench-contracts';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_ERRORS,
  formatInputNumber,
  openPositionParams,
  prefillDraft,
  requiredSol,
  strategyPlan,
  tradeSummary,
  validateDraft,
  type PaperDraft,
} from './paper-strategy';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DRAFT: PaperDraft = { stake: 0.1, entry: 1, slPct: 30 };

const FEE = 0.0002;
/** Leg exiting at `multiple` × the FILL price (levels recomputed at fill, like the engine), before fees. */
const presetLeg = (stake: number, multiple: number) => stake * (multiple * 0.98 - 1);

describe('paper sheet prefill (market entry only)', () => {
  it('enters at the current price with the settings stake and stop', () => {
    expect(prefillDraft(2, { stake: 0.3, slPct: 40 })).toEqual({ stake: 0.3, entry: 2, slPct: 40 });
  });

  it('is null without a usable price (no zone entry any more)', () => {
    for (const p of [null, 0, -1, Number.NaN]) expect(prefillDraft(p, { stake: 0.1, slPct: 30 })).toBeNull();
  });
});

describe('paper strategy plan (all_x2)', () => {
  it('one target at ×2 and the stop at −sl %', () => {
    expect(strategyPlan(DRAFT)).toEqual({ tpPrice: 2, slPrice: 0.7 });
    expect(strategyPlan({ ...DRAFT, slPct: 20 }).slPrice).toBeCloseTo(0.8, 12);
  });
});

describe('paper sheet validation', () => {
  it('accepts the prefilled draft', () => {
    expect(validateDraft(DRAFT, 1)).toEqual({});
  });

  it('checks the stake (0.01–100 SOL) against the balance, buy fee and rent included', () => {
    expect(validateDraft({ ...DRAFT, stake: 0.005 }, 1).stake).toBe(DRAFT_ERRORS.stake);
    expect(validateDraft({ ...DRAFT, stake: Number.NaN }, 1).stake).toBe(DRAFT_ERRORS.stake);
    expect(requiredSol(0.1)).toBeCloseTo(0.1 + 0.0002 + 0.00204, 9);
    expect(validateDraft(DRAFT, requiredSol(0.1))).toEqual({});
    expect(validateDraft(DRAFT, requiredSol(0.1) - 0.0001).stake).toBe(DRAFT_ERRORS.balance);
  });

  it('checks the stop percent (integer 1–90) and the entry price', () => {
    for (const v of [0, 91, 12.5, Number.NaN]) expect(validateDraft({ ...DRAFT, slPct: v }, 1).slPct).toBe(DRAFT_ERRORS.slPct);
    expect(validateDraft({ ...DRAFT, entry: 0 }, 1).entry).toBe(DRAFT_ERRORS.price);
  });
});

describe('paper sheet summary maths', () => {
  it('2 transactions (buy + sell), rent, and the target / stop scenarios on fill-based levels', () => {
    const s = tradeSummary(DRAFT);
    expect(s?.txCount).toBe(2);
    expect(s?.networkFeesSol).toBeCloseTo(2 * FEE, 12);
    expect(s?.rentSol).toBe(0.00204);
    expect(s?.requiredSol).toBeCloseTo(0.1 + FEE + 0.00204, 9);
    expect(s?.plan).toEqual({ tpPrice: 2, slPrice: 0.7 });
    expect(s?.scenarios.map((x) => [x.key, x.label])).toEqual([
      ['tp', 'Objectif ×2 atteint'],
      ['sl', 'Stop touché (−30 %)'],
    ]);
    expect(s?.scenarios[0]!.pnlSol).toBeCloseTo(presetLeg(0.1, 2) - 2 * FEE, 8);
    expect(s?.scenarios[1]!.pnlSol).toBeCloseTo(presetLeg(0.1, 0.7) - 2 * FEE, 8);
    expect(s?.scenarios[1]!.pnlPct).toBeCloseTo(((s?.scenarios[1]!.pnlSol ?? 0) / 0.1) * 100, 6);
  });

  it('returns null for an invalid draft', () => {
    expect(tradeSummary({ ...DRAFT, slPct: 0 })).toBeNull();
  });
});

describe('POST /api/paper/positions body', () => {
  it('sends exactly the contract fields: all_x2, market entry, main book, no custom prices', () => {
    const body = openPositionParams(DRAFT, MINT);
    expect(body).toEqual({
      mint: MINT,
      strategy: 'all_x2',
      stake_sol: 0.1,
      entry_price: 1,
      sl_pct: 30,
      custom_tp_price: null,
      custom_sl_price: null,
      book: 'main',
    });
    expect(paperOpenRequestSchema.safeParse(body).success).toBe(true);
  });

  it('formats input numbers with a French comma and no exponent', () => {
    expect(formatInputNumber(0.00012345)).toBe('0,00012345');
    expect(formatInputNumber(1.5e-9)).toBe('0,0000000015');
    expect(formatInputNumber(Number.NaN)).toBe('');
  });
});
