import { describe, expect, it } from 'vitest';
import type { AlertLogRow } from './alert-log';
import {
  ASSUMED_ROUNDTRIP_PCT,
  SIMULATION_WINDOW_MS,
  formatSignedSol,
  isInWindow,
  simulateAlert,
  simulateAlerts,
  simulationDetail,
  simulationHeadline,
} from './alert-simulation';

const A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = Date.parse('2026-11-17T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

let nextId = 0;
const row = (over: Partial<AlertLogRow> = {}): AlertLogRow => ({
  id: ++nextId,
  mint: A,
  sent_at: hoursAgo(1),
  kind: 'single',
  entry_price: 1,
  target_price: 1.2,
  stop_price: 0.8,
  entry_roundtrip_pct: 2,
  stake_sol: null,
  max_price: null,
  min_price: null,
  last_price: null,
  last_price_at: null,
  first_hit: null,
  first_hit_at: null,
  followup_sent_at: null,
  tracking_until: null,
  ...over,
});

describe('simulateAlert (one single alert)', () => {
  it('books the target return when the target was hit first, minus the round trip', () => {
    const t = simulateAlert(row({ first_hit: 'target' }), 0.1);
    expect(t?.outcome).toBe('target');
    expect(t?.grossReturn).toBeCloseTo(0.2, 12);
    expect(t?.costPct).toBeCloseTo(2, 12);
    expect(t?.netReturn).toBeCloseTo(0.18, 12);
    expect(t?.pnlSol).toBeCloseTo(0.018, 12);
    expect(t?.costAssumed).toBe(false);
  });

  it('books the stop return when the stop was hit first', () => {
    const t = simulateAlert(row({ first_hit: 'stop', last_price: 2 }), 0.1);
    expect(t?.outcome).toBe('stop');
    expect(t?.netReturn).toBeCloseTo(-0.22, 12);
  });

  it('marks open alerts to market with last_price (0 % without any price yet)', () => {
    expect(simulateAlert(row({ last_price: 1.05 }), 0.1)?.netReturn).toBeCloseTo(0.03, 12);
    expect(simulateAlert(row({ last_price: 1.05 }), 0.1)?.outcome).toBe('open');
    expect(simulateAlert(row({ last_price: null }), 0.1)?.grossReturn).toBe(0);
  });

  it('falls back to the « Jeune calme » plan (×2 / ×0.7) when the target/stop columns are missing', () => {
    expect(simulateAlert(row({ first_hit: 'target', target_price: null }), 0.1)?.grossReturn).toBeCloseTo(1, 12);
    expect(simulateAlert(row({ first_hit: 'stop', stop_price: null }), 0.1)?.grossReturn).toBeCloseTo(-0.3, 12);
  });

  it('scales a known round-trip cost with the stake (estimate helper)', () => {
    // 2 % for 0.1 SOL, no fee part → 10 % for 0.5 SOL.
    const t = simulateAlert(row({ first_hit: 'target' }), 0.5);
    expect(t?.costPct).toBeCloseTo(10, 9);
    expect(t?.netReturn).toBeCloseTo(0.1, 9);
    expect(t?.pnlSol).toBeCloseTo(0.05, 9);
  });

  it('assumes 3 % when the cost is unknown, whatever the stake', () => {
    for (const stake of [0.1, 2]) {
      const t = simulateAlert(row({ first_hit: 'target', entry_roundtrip_pct: null }), stake);
      expect(t?.costPct).toBe(ASSUMED_ROUNDTRIP_PCT);
      expect(t?.costAssumed).toBe(true);
      expect(t?.netReturn).toBeCloseTo(0.17, 12);
    }
  });

  it('uses the user stake, then alert_log.stake_sol, then 0.05 SOL (default)', () => {
    const r = row({ first_hit: 'target', entry_roundtrip_pct: null, stake_sol: 0.25 });
    expect(simulateAlert(r, 1)?.stakeSol).toBe(1);
    expect(simulateAlert(r, null)?.stakeSol).toBe(0.25);
    expect(simulateAlert(r, 0)?.stakeSol).toBe(0.25);
    expect(simulateAlert(r, null)?.pnlSol).toBeCloseTo(0.25 * 0.17, 12);
    expect(simulateAlert(row({ stake_sol: null }), null)?.stakeSol).toBe(0.05);
  });

  it('skips grouped alerts and alerts without an entry price', () => {
    expect(simulateAlert(row({ kind: 'grouped', first_hit: 'target' }), 0.1)).toBeNull();
    expect(simulateAlert(row({ entry_price: null }), 0.1)).toBeNull();
  });
});

describe('7-day window', () => {
  it('includes exactly 7 days ago and excludes 1 ms earlier and the future', () => {
    expect(isInWindow(new Date(NOW - SIMULATION_WINDOW_MS).toISOString(), NOW)).toBe(true);
    expect(isInWindow(new Date(NOW - SIMULATION_WINDOW_MS - 1).toISOString(), NOW)).toBe(false);
    expect(isInWindow(new Date(NOW + 60_000).toISOString(), NOW)).toBe(false);
    expect(isInWindow('nope', NOW)).toBe(false);
  });

  it('only simulates the alerts of the window', () => {
    const s = simulateAlerts(
      [
        row({ first_hit: 'target', sent_at: new Date(NOW - SIMULATION_WINDOW_MS).toISOString() }),
        row({ first_hit: 'target', sent_at: new Date(NOW - SIMULATION_WINDOW_MS - 1).toISOString() }),
      ],
      { now: NOW, stakeSol: 0.1 },
    );
    expect(s.alerts).toBe(1);
    expect(s.trades).toHaveLength(1);
  });
});

describe('simulateAlerts (summary)', () => {
  const rows = () => [
    row({ first_hit: 'target' }),
    row({ first_hit: 'stop' }),
    row({ last_price: 1.05 }),
    row({ kind: 'grouped', first_hit: 'target' }),
  ];

  it('counts outcomes, sums the SOL result and averages the net %', () => {
    const s = simulateAlerts(rows(), { now: NOW, stakeSol: 0.1 });
    expect(s).toMatchObject({ alerts: 4, targets: 1, stops: 1, open: 1, feesAssumed: false, stakeSol: 0.1 });
    expect(s.trades).toHaveLength(3); // grouped excluded
    expect(s.pnlSol).toBeCloseTo(0.1 * (0.18 - 0.22 + 0.03), 12);
    expect(s.avgNetPct).toBeCloseTo(((0.18 - 0.22 + 0.03) / 3) * 100, 9);
  });

  it('writes the headline and the detail line in French', () => {
    const s = simulateAlerts(rows(), { now: NOW, stakeSol: 0.1 });
    expect(simulationHeadline(s)).toBe('7 derniers jours : 4 alertes · 1 objectif · 1 stop · résultat simulé pour ma mise : −0,001 SOL (frais inclus)');
    expect(simulationDetail(s)).toBe(
      '3 alertes simulées : 1 objectif · 1 stop · 1 en cours · moyenne nette −0,3 % · mise 0,1 SOL par alerte · frais aller-retour inclus',
    );
  });

  it('says « frais estimés » when a cost was assumed', () => {
    const s = simulateAlerts([row({ first_hit: 'target', entry_roundtrip_pct: null })], { now: NOW, stakeSol: 0.1 });
    expect(s.feesAssumed).toBe(true);
    expect(simulationDetail(s)).toContain('frais estimés à 3 % quand inconnus');
    expect(simulationHeadline(s)).toBe('7 derniers jours : 1 alerte · 1 objectif · 0 stop · résultat simulé pour ma mise : +0,017 SOL (frais inclus)');
  });

  it('reports mixed fallback stakes without a single stake value', () => {
    const s = simulateAlerts([row({ stake_sol: 0.5 }), row({ stake_sol: null })], { now: NOW, stakeSol: null });
    expect(s.stakeSol).toBeNull();
    expect(simulationDetail(s)).toContain('mise par alerte');
  });

  it('handles an empty window', () => {
    const s = simulateAlerts([row({ kind: 'grouped' })], { now: NOW, stakeSol: 0.1 });
    expect(s).toMatchObject({ alerts: 1, targets: 0, stops: 0, open: 0, pnlSol: 0, avgNetPct: null, stakeSol: null });
    expect(simulationHeadline(s)).toBe('7 derniers jours : 1 alerte · 0 objectif · 0 stop · résultat simulé pour ma mise : 0 SOL (frais inclus)');
    expect(simulationDetail(s)).toBe('Aucune alerte simple avec un prix d’entrée sur la période.');
  });
});

describe('formatSignedSol', () => {
  it('signs and rounds to 3 decimals (French comma, U+2212 minus)', () => {
    expect(formatSignedSol(0.0181)).toBe('+0,018 SOL');
    expect(formatSignedSol(-1.25)).toBe('−1,25 SOL');
    expect(formatSignedSol(0.0001)).toBe('0 SOL');
    expect(formatSignedSol(Number.NaN)).toBe('0 SOL');
  });
});
