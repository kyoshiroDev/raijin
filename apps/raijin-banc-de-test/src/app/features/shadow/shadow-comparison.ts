// Comparaison du mode ombre (docs/ARCHITECTURE.md §17.6) : collecte du VPS (`public`) contre l'instantané Supabase
// (`shadow_ref`, copié par `infra/bench-migrate.sh --shadow-snapshot`, lancé par l'utilisateur). Pur, sans E/S.
// Seuils OFFICIELS de bascule : `SHADOW_ACCEPTANCE` de `@raijin/bench-contracts` (docs/BENCH.md §12), lus ici sans copie.
import {
  SHADOW_ACCEPTANCE,
  SHADOW_TABLES,
  SHADOW_WINDOW_MAX_DAYS,
  shadowComparisonSchema,
  type ShadowAcceptanceStatus,
  type ShadowComparison,
  type ShadowDayRow,
  type ShadowTable,
  type ShadowTableStatus,
} from '@raijin/bench-contracts';

export const SHADOW_TABLE_LABEL: Readonly<Record<ShadowTable, string>> = {
  tokens: 'Tokens',
  token_snapshots: 'Historique des prix',
  scan_runs: 'Passages du scan',
  alert_log: 'Alertes',
  paper_positions: 'Positions paper',
  signal_outcomes: 'Issues des signaux',
  preset_signals: 'Signaux des presets',
};

/** Fenêtres proposées (jours, fin incluse) ; 31 jours au plus (contrat). `snapshot` : fenêtre du dernier instantané. */
export const SHADOW_WINDOWS = ['snapshot', 7, 14, SHADOW_WINDOW_MAX_DAYS] as const;
export type ShadowWindow = (typeof SHADOW_WINDOWS)[number];

/** `none` rien des deux côtés · `ok` dans la tolérance · `notice` hors tolérance · `info` table informative (non bloquante). */
export type DiffLevel = 'none' | 'ok' | 'notice' | 'info';

export interface ShadowTableSummary {
  readonly table: ShadowTable;
  readonly label: string;
  readonly days: number;
  readonly vpsRows: number;
  readonly refRows: number;
  /** (vps − ref) / ref en pourcent sur la fenêtre ; null si la référence est vide. */
  readonly diffPct: number | null;
  readonly onlyVps: number | null;
  readonly onlyRef: number | null;
  readonly level: DiffLevel;
}

/** Corps non fiable → comparaison conforme au contrat, ou null. */
export function parseShadowComparison(body: unknown): ShadowComparison | null {
  const parsed = shadowComparisonSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** `AAAA-MM-JJ` UTC. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Fenêtre de `days` jours finissant aujourd'hui (UTC), bornes incluses. */
export function windowRange(days: Exclude<ShadowWindow, 'snapshot'>, now = Date.now()): { from: string; to: string } {
  return { from: isoDay(now - (days - 1) * 86_400_000), to: isoDay(now) };
}

/** Jours (UTC, bornes incluses) couvrant la fenêtre `[from ; to[` de l'instantané (≤ 31 jours, contrat). */
export function snapshotRange(window: { from: string; to: string }): { from: string; to: string } {
  const to = Date.parse(window.to);
  // `to` exclu : une fin à minuit pile appartient au jour précédent.
  return { from: isoDay(Date.parse(window.from)), to: isoDay(to % 86_400_000 === 0 ? to - 1 : to) };
}

export function diffPct(vps: number, ref: number): number | null {
  return ref === 0 ? null : ((vps - ref) / ref) * 100;
}

/** Niveau d'un écart selon la tolérance de la table (`maxPct` : journalière ou de fenêtre). */
export function diffLevel(table: ShadowTable, pct: number | null, vps: number, ref: number, scope: 'day' | 'window'): DiffLevel {
  const tol = SHADOW_ACCEPTANCE.tables[table];
  if (!tol.blocking) return 'info';
  if (pct === null) return vps === 0 ? 'none' : 'notice';
  if (scope === 'day' && ref < SHADOW_ACCEPTANCE.minRefRowsPerDay) return 'ok';
  return Math.abs(pct) > (scope === 'day' ? tol.maxDayDiffPct : tol.maxWindowDiffPct) ? 'notice' : 'ok';
}

/** Niveau d'une ligne journalière. */
export function dayLevel(row: ShadowDayRow): DiffLevel {
  return diffLevel(row.table, row.diff_pct, row.vps_rows, row.ref_rows, 'day');
}

/** Tolérance affichée : « ±5 % (jour ±10 %) », « informative ». */
export function toleranceLabel(table: ShadowTable): string {
  const tol = SHADOW_ACCEPTANCE.tables[table];
  if (!tol.blocking) return 'informative en ombre';
  const mints = tol.maxOneSideMintPct === null ? '' : ` · mints d’un seul côté ≤ ${tol.maxOneSideMintPct} %`;
  return `±${tol.maxWindowDiffPct} % (jour ±${tol.maxDayDiffPct} %)${mints}`;
}

export const ACCEPTANCE_LABEL: Readonly<Record<ShadowAcceptanceStatus, string>> = {
  no_snapshot: 'Aucun instantané importé : pas de verdict de bascule.',
  too_short: `Instantané trop court : ${SHADOW_ACCEPTANCE.minFullDays} jours UTC complets au minimum (${SHADOW_ACCEPTANCE.recommendedFullDays} conseillés).`,
  partial: 'La période affichée ne couvre pas tout l’instantané : choisis « Instantané ».',
  fail: 'Hors tolérance : bascule refusée (docs/BENCH.md §12).',
  insufficient: `Échantillon insuffisant (moins de ${SHADOW_ACCEPTANCE.minRefRows} lignes de référence) : prolonge le mode ombre.`,
  pass: 'Données conformes aux seuils. Vérifie aussi le budget Helius et les jobs (docs/BENCH.md §12) avant de basculer.',
};

export const TABLE_STATUS_LABEL: Readonly<Record<ShadowTableStatus, string>> = {
  pass: 'Conforme',
  fail: 'Hors tolérance',
  insufficient: 'Échantillon insuffisant',
  inconclusive: 'Non concluant',
  info: 'Informative',
};

const sumNullable = (values: readonly (number | null)[]): number | null =>
  values.every((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0);

/** Totaux par table (ordre du contrat), tables absentes de la réponse omises. */
export function summarizeByTable(rows: readonly ShadowDayRow[]): ShadowTableSummary[] {
  return SHADOW_TABLES.flatMap((table) => {
    const own = rows.filter((r) => r.table === table);
    if (own.length === 0) return [];
    const vpsRows = own.reduce((a, r) => a + r.vps_rows, 0);
    const refRows = own.reduce((a, r) => a + r.ref_rows, 0);
    const pct = diffPct(vpsRows, refRows);
    return [
      {
        table,
        label: SHADOW_TABLE_LABEL[table],
        days: own.length,
        vpsRows,
        refRows,
        diffPct: pct,
        onlyVps: sumNullable(own.map((r) => r.only_vps_count)),
        onlyRef: sumNullable(own.map((r) => r.only_ref_count)),
        level: diffLevel(table, pct, vpsRows, refRows, 'window'),
      },
    ];
  });
}

/** Lignes par table puis par jour décroissant (le plus récent d'abord). */
export function sortRows(rows: readonly ShadowDayRow[]): ShadowDayRow[] {
  const order = (t: ShadowTable) => SHADOW_TABLES.indexOf(t);
  return [...rows].sort((a, b) => order(a.table) - order(b.table) || b.day.localeCompare(a.day));
}

const PCT = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1, signDisplay: 'exceptZero' });
const INT = new Intl.NumberFormat('fr-FR');

/** « +2,5 % », « 0,0 % », « — » (référence vide). */
export function formatDiff(pct: number | null): string {
  return pct === null ? '—' : `${PCT.format(pct)} %`;
}

export function formatRows(n: number | null): string {
  return n === null ? '—' : INT.format(n);
}

/** « 24/11/2026 » d'un jour ISO, sans décalage de fuseau. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}
