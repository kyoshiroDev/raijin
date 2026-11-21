import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { SUPABASE } from '../supabase/supabase-client';
import { UserPreferences } from './user-preferences';

function setup(result: () => Promise<{ data: unknown; error: unknown }>) {
  const select = vi.fn(() => ({ maybeSingle: result }));
  const from = vi.fn(() => ({ select }));
  TestBed.configureTestingModule({ providers: [{ provide: SUPABASE, useValue: { from } }] });
  return { prefs: TestBed.inject(UserPreferences), from, select };
}

describe('UserPreferences', () => {
  it('defaults to 0.05 SOL and does not query on creation', () => {
    const { prefs, from } = setup(async () => ({ data: null, error: null }));
    expect(prefs.stakeSol()).toBe(0.05);
    expect(from).not.toHaveBeenCalled();
  });

  it('reads stake_sol from alert_settings (Supabase only)', async () => {
    const { prefs, from, select } = setup(async () => ({ data: { stake_sol: 0.5 }, error: null }));
    await prefs.load();
    expect(from).toHaveBeenCalledWith('alert_settings');
    expect(select).toHaveBeenCalledWith('stake_sol,paper_sl_pct');
    expect(prefs.stakeSol()).toBe(0.5);
  });

  it('reads the default paper stop %, falling back to 30 % (no strategy any more: always « tout à ×2 »)', async () => {
    const { prefs } = setup(async () => ({ data: { stake_sol: 0.5, paper_sl_pct: 25 }, error: null }));
    expect(prefs.paperSlPct()).toBe(30);
    await prefs.load();
    expect(prefs.paperSlPct()).toBe(25);
    TestBed.resetTestingModule();
    const bad = setup(async () => ({ data: { paper_sl_pct: 120 }, error: null }));
    await bad.prefs.load();
    expect(bad.prefs.paperSlPct()).toBe(30);
  });

  it('accepts a valid paper stop from the settings, ignores invalid ones, and reset() restores it', () => {
    const { prefs } = setup(async () => ({ data: null, error: null }));
    prefs.setPaperSlPct(45);
    expect(prefs.paperSlPct()).toBe(45);
    prefs.setPaperSlPct(0);
    prefs.setPaperSlPct(12.5);
    expect(prefs.paperSlPct()).toBe(45);
    prefs.reset();
    expect(prefs.paperSlPct()).toBe(30);
  });

  it('keeps 0.05 when there is no row, an invalid value or an error', async () => {
    for (const r of [{ data: null, error: null }, { data: { stake_sol: 1000 }, error: null }, { data: null, error: { code: '500' } }]) {
      TestBed.resetTestingModule();
      const { prefs } = setup(async () => r);
      await prefs.load();
      expect(prefs.stakeSol()).toBe(0.05);
    }
    TestBed.resetTestingModule();
    const { prefs } = setup(async () => {
      throw new Error('network');
    });
    await prefs.load();
    expect(prefs.stakeSol()).toBe(0.05);
  });

  it('accepts a valid setStake, ignores invalid ones, and reset() restores the default', () => {
    const { prefs } = setup(async () => ({ data: null, error: null }));
    prefs.setStake(2);
    expect(prefs.stakeSol()).toBe(2);
    prefs.setStake(0.005);
    prefs.setStake(Number.NaN);
    expect(prefs.stakeSol()).toBe(2);
    prefs.reset();
    expect(prefs.stakeSol()).toBe(0.05);
  });

  it('ignores a slow load that finishes after a reset (previous session)', async () => {
    let resolve: (v: { data: unknown; error: unknown }) => void = () => undefined;
    const { prefs } = setup(() => new Promise((r) => (resolve = r)));
    const pending = prefs.load();
    prefs.reset();
    resolve({ data: { stake_sol: 3 }, error: null });
    await pending;
    expect(prefs.stakeSol()).toBe(0.05);
  });
});
