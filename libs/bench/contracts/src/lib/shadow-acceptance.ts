import type { ShadowComparison, ShadowDayRow, ShadowTable } from './shadow';
import { SHADOW_TABLES } from './shadow';

/**
 * Seuils OFFICIELS de bascule du banc (mode ombre → `primary`), docs/BENCH.md §12. Source unique : l'écran
 * `/comparaison` du front les lit ici, la procédure les cite. Ils mesurent la FIDÉLITÉ du portage (le VPS
 * collecte-t-il la même chose que Supabase ?), pas une performance de trading.
 *
 * Règles de lecture :
 * - seuls les jours UTC **entièrement** couverts par la fenêtre de l'instantané comptent (le jour du démarrage et
 *   le jour de l'instantané sont partiels d'un côté ou de l'autre) ;
 * - un écart se lit en pourcent de la référence Supabase : `(vps − réf.) / réf.` ;
 * - sous `minRefRows` lignes de référence sur la fenêtre, la table est « échantillon insuffisant » : elle ne
 *   valide rien et bloque la bascule, jusqu'à `inconclusiveAfterDays` jours complets où elle devient
 *   « non concluante » (consignée avec son n, non bloquante) ;
 * - `alert_log` et `paper_positions` sont informatives : en ombre, push et ouvertures automatiques sont coupés,
 *   le VPS en a donc (presque) zéro. Elles se vérifient après le passage en `primary` (BENCH.md §12, étape 9).
 */
export interface ShadowTableTolerance {
  /** La table compte pour la décision de bascule. */
  readonly blocking: boolean;
  /** Écart absolu maximal (%) sur la somme des jours complets. */
  readonly maxWindowDiffPct: number;
  /** Écart absolu maximal (%) sur un jour complet, pour les jours dont la référence a au moins `minRefRowsPerDay` lignes. */
  readonly maxDayDiffPct: number;
  /** Mints présents d'un seul côté (chaque côté), en % des lignes de référence ; `null` : non évalué. */
  readonly maxOneSideMintPct: number | null;
}

export const SHADOW_ACCEPTANCE = {
  /** Jours UTC complets comparés, au minimum (3 passages des jobs quotidiens : backtest, agrégats, purge). */
  minFullDays: 3,
  /** Durée conseillée (un cycle hebdomadaire complet). */
  recommendedFullDays: 7,
  /** Au-delà, une table encore sous `minRefRows` est « non concluante » et ne bloque plus. */
  inconclusiveAfterDays: 14,
  /** Lignes de référence minimales sur la fenêtre pour juger une table. */
  minRefRows: 30,
  /** Lignes de référence minimales pour juger un jour isolé. */
  minRefRowsPerDay: 30,
  /** Crédits Helius du banc : chaque jour complet ≤ 80 % du budget journalier (10 000 → 8 000), jamais épuisé. */
  heliusMaxDailyRatio: 0.8,
  /** Jobs (`job_runs` sur la fenêtre). */
  jobs: {
    /** Jobs fréquents (≥ `minRunsForRatio` exécutions sur la fenêtre) : `failed` ≤ 1 % des exécutions. */
    maxFailedRatio: 0.01,
    minRunsForRatio: 100,
    /** Jobs rares (quotidiens, < `minRunsForRatio` exécutions) : aucun `failed`. */
    maxFailedRare: 0,
    /** Aucun échec, quel que soit le job, sur les 24 h qui précèdent la bascule. */
    maxFailedLast24h: 0,
    /** `consecutive_failures` de `GET /api/status` au moment de la bascule. */
    maxConsecutiveFailures: 0,
    /** `skipped` (chevauchement) ≤ 5 % des exécutions d'un job fréquent. */
    maxSkippedRatio: 0.05,
    /** Aucune exécution `running` plus vieille que ce délai (job bloqué). */
    maxRunningMinutes: 60,
  },
  tables: {
    scan_runs: { blocking: true, maxWindowDiffPct: 2, maxDayDiffPct: 5, maxOneSideMintPct: null },
    tokens: { blocking: true, maxWindowDiffPct: 5, maxDayDiffPct: 10, maxOneSideMintPct: 10 },
    token_snapshots: { blocking: true, maxWindowDiffPct: 5, maxDayDiffPct: 10, maxOneSideMintPct: null },
    signal_outcomes: { blocking: true, maxWindowDiffPct: 10, maxDayDiffPct: 20, maxOneSideMintPct: 15 },
    preset_signals: { blocking: true, maxWindowDiffPct: 10, maxDayDiffPct: 20, maxOneSideMintPct: 15 },
    alert_log: { blocking: false, maxWindowDiffPct: 10, maxDayDiffPct: 20, maxOneSideMintPct: null },
    paper_positions: { blocking: false, maxWindowDiffPct: 10, maxDayDiffPct: 20, maxOneSideMintPct: null },
  } satisfies Readonly<Record<ShadowTable, ShadowTableTolerance>>,
} as const;

/** `pass` conforme · `fail` hors tolérance · `insufficient` trop peu de lignes · `inconclusive` insuffisant après 14 j · `info` non bloquante. */
export type ShadowTableStatus = 'pass' | 'fail' | 'insufficient' | 'inconclusive' | 'info';

export interface ShadowTableAcceptance {
  readonly table: ShadowTable;
  readonly status: ShadowTableStatus;
  /** Jours complets présents pour cette table. */
  readonly days: number;
  readonly vpsRows: number;
  readonly refRows: number;
  /** Écart (%) sur la fenêtre ; `null` si la référence est vide. */
  readonly diffPct: number | null;
  /** Pire écart journalier (%) parmi les jours jugés ; `null` si aucun jour n'atteint `minRefRowsPerDay`. */
  readonly worstDayDiffPct: number | null;
  /** Mints d'un seul côté, en % des lignes de référence (le pire des deux côtés) ; `null` : non évalué. */
  readonly oneSideMintPct: number | null;
  /** Raisons d'un `fail` (texte court, en français). */
  readonly reasons: readonly string[];
}

/** `no_snapshot` · `too_short` (< 3 jours complets) · `partial` (fenêtre demandée plus courte que l'instantané) · `fail` · `insufficient` · `pass`. */
export type ShadowAcceptanceStatus = 'no_snapshot' | 'too_short' | 'partial' | 'fail' | 'insufficient' | 'pass';

export interface ShadowAcceptance {
  readonly status: ShadowAcceptanceStatus;
  /** Jours UTC complets de l'instantané (`AAAA-MM-JJ`, croissants) compris dans la réponse. */
  readonly fullDays: readonly string[];
  /** Jours complets de l'instantané (toute la fenêtre de `snapshot_window`). */
  readonly snapshotFullDays: number;
  readonly tables: readonly ShadowTableAcceptance[];
}

const DAY_MS = 86_400_000;

/** Jours UTC `[d 00:00 ; d+1 00:00[` entièrement compris dans `[from ; to[`. */
export function fullUtcDays(from: string, to: string): string[] {
  const start = Math.ceil(Date.parse(from) / DAY_MS) * DAY_MS;
  const end = Math.floor(Date.parse(to) / DAY_MS) * DAY_MS;
  const days: string[] = [];
  for (let t = start; t + DAY_MS <= end; t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

const pct = (vps: number, ref: number): number | null => (ref === 0 ? null : ((vps - ref) / ref) * 100);
const round1 = (n: number): string => (Math.round(n * 10) / 10).toString().replace('.', ',');

/** Verdict d'une table sur les jours complets (lignes déjà filtrées sur la table). */
export function evaluateShadowTable(table: ShadowTable, rows: readonly ShadowDayRow[], fullDayCount: number): ShadowTableAcceptance {
  const tol: ShadowTableTolerance = SHADOW_ACCEPTANCE.tables[table];
  const vpsRows = rows.reduce((a, r) => a + r.vps_rows, 0);
  const refRows = rows.reduce((a, r) => a + r.ref_rows, 0);
  const diffPct = pct(vpsRows, refRows);
  let worstDayDiffPct: number | null = null;
  for (const r of rows) {
    if (r.ref_rows < SHADOW_ACCEPTANCE.minRefRowsPerDay) continue;
    const d = pct(r.vps_rows, r.ref_rows);
    if (d !== null && (worstDayDiffPct === null || Math.abs(d) > Math.abs(worstDayDiffPct))) worstDayDiffPct = d;
  }
  let oneSideMintPct: number | null = null;
  if (tol.maxOneSideMintPct !== null && refRows > 0 && rows.some((r) => r.only_vps_count !== null || r.only_ref_count !== null)) {
    const onlyVps = rows.reduce((a, r) => a + (r.only_vps_count ?? 0), 0);
    const onlyRef = rows.reduce((a, r) => a + (r.only_ref_count ?? 0), 0);
    oneSideMintPct = (Math.max(onlyVps, onlyRef) / refRows) * 100;
  }
  const reasons: string[] = [];
  if (diffPct !== null && Math.abs(diffPct) > tol.maxWindowDiffPct) reasons.push(`écart ${round1(diffPct)} % sur la fenêtre (max ${tol.maxWindowDiffPct} %)`);
  if (worstDayDiffPct !== null && Math.abs(worstDayDiffPct) > tol.maxDayDiffPct) reasons.push(`écart ${round1(worstDayDiffPct)} % sur un jour (max ${tol.maxDayDiffPct} %)`);
  if (oneSideMintPct !== null && tol.maxOneSideMintPct !== null && oneSideMintPct > tol.maxOneSideMintPct) {
    reasons.push(`${round1(oneSideMintPct)} % de mints d'un seul côté (max ${tol.maxOneSideMintPct} %)`);
  }
  let status: ShadowTableStatus;
  if (!tol.blocking) status = 'info';
  else if (refRows < SHADOW_ACCEPTANCE.minRefRows) status = fullDayCount >= SHADOW_ACCEPTANCE.inconclusiveAfterDays ? 'inconclusive' : 'insufficient';
  else status = reasons.length > 0 ? 'fail' : 'pass';
  return { table, status, days: rows.length, vpsRows, refRows, diffPct, worstDayDiffPct, oneSideMintPct, reasons };
}

/**
 * Verdict de bascule d'une réponse `GET /api/shadow/comparison` (données seules ; les critères Helius et jobs se
 * lisent ailleurs, BENCH.md §12). À appeler sur une réponse SANS filtre de table. `partial` : la réponse ne couvre
 * pas tous les jours complets de l'instantané (l'écran demande alors la fenêtre de l'instantané).
 */
export function evaluateShadowAcceptance(comparison: ShadowComparison): ShadowAcceptance {
  const window = comparison.snapshot_window;
  if (window === null) return { status: 'no_snapshot', fullDays: [], snapshotFullDays: 0, tables: [] };
  const snapshotDays = fullUtcDays(window.from, window.to);
  const fullDays = snapshotDays.filter((d) => d >= comparison.from && d <= comparison.to);
  const inWindow = new Set(fullDays);
  // Toutes les tables (une table absente de la réponse compte 0 ligne) : réponse demandée SANS filtre de table.
  const tables = SHADOW_TABLES.map((t) =>
    evaluateShadowTable(
      t,
      comparison.rows.filter((r) => r.table === t && inWindow.has(r.day)),
      fullDays.length,
    ),
  );
  let status: ShadowAcceptanceStatus;
  if (snapshotDays.length < SHADOW_ACCEPTANCE.minFullDays) status = 'too_short';
  else if (fullDays.length < snapshotDays.length) status = 'partial';
  else if (tables.some((t) => t.status === 'fail')) status = 'fail';
  else if (tables.some((t) => t.status === 'insufficient')) status = 'insufficient';
  else status = 'pass';
  return { status, fullDays, snapshotFullDays: snapshotDays.length, tables };
}
