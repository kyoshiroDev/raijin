// Comparaison du mode ombre (docs/ARCHITECTURE.md §17.6) : collecte du VPS (`public`) contre l'instantané Supabase
// (`shadow_ref`, copié par `infra/bench-migrate.sh --shadow-snapshot`, lancé par l'utilisateur). Pur, sans E/S.
// Les seuils officiels d'acceptation de la bascule sont fixés par la procédure (docs/BENCH.md) ; l'écran ne fait que
// signaler visuellement les écarts au-delà d'un repère.
import {
  SHADOW_TABLES,
  SHADOW_WINDOW_MAX_DAYS,
  shadowComparisonSchema,
  type ShadowComparison,
  type ShadowDayRow,
  type ShadowTable,
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

/** Fenêtres proposées (jours, fin incluse) ; 31 jours au plus (contrat). */
export const SHADOW_WINDOWS = [7, 14, SHADOW_WINDOW_MAX_DAYS] as const;
export type ShadowWindow = (typeof SHADOW_WINDOWS)[number];

/** Repère visuel : écart absolu au-delà duquel une ligne est signalée (pas un seuil d'acceptation). */
export const SHADOW_NOTICE_PCT = 5;

export type DiffLevel = 'none' | 'ok' | 'notice';

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
export function windowRange(days: ShadowWindow, now = Date.now()): { from: string; to: string } {
  return { from: isoDay(now - (days - 1) * 86_400_000), to: isoDay(now) };
}

export function diffPct(vps: number, ref: number): number | null {
  return ref === 0 ? null : ((vps - ref) / ref) * 100;
}

export function diffLevel(pct: number | null, vps = 0): DiffLevel {
  if (pct === null) return vps === 0 ? 'none' : 'notice';
  return Math.abs(pct) > SHADOW_NOTICE_PCT ? 'notice' : 'ok';
}

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
        level: diffLevel(pct, vpsRows),
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
