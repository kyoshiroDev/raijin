// Pure parsing / selection of public.performance_by_preset() rows (Performance screen, « Calme vs Frénésie » card).
// Rates use `labelled` (rows with an OHLCV outcome) as denominator; the 30-observation rule of the breakdown applies.
// Only young_calm / young_frenzy are kept (slim-down 2026-11-21): rows of the removed presets (momentum, young_strong,
// strict) or of their age segments are ignored.
import { parseCount, type RateCell } from './performance-breakdown';
import { formatCount, formatSignedSol } from '../../shared/utils/format';
import { formatHits, formatRate, hasEnoughSample } from './performance-stats';

/** « Calme vs Frénésie » comparison (young_calm alerts + young_frenzy control preset, auto-paper only). */
export type PerfPreset = 'young_calm' | 'young_frenzy';
export type PresetSegment = 'all' | 'gta' | 'other';

export interface PresetRow {
  preset: PerfPreset;
  segment: PresetSegment;
  signals: number;
  labelled: number;
  x2_before_sl30: number;
  sl30_before_x2: number;
  /** Simulated from the labels (all at ×2, 0.1 SOL per trade, round trip deducted); null when unknown. */
  sim_pnl_sol: number | null;
  /** Closed virtual positions of the preset's books. */
  trades: number;
  /** Realised P&L of those positions (SOL); null when the preset has no book. */
  paper_pnl_sol: number | null;
  /** Pending + open virtual positions of those books. */
  paper_open: number;
}

/** Columns of the « Calme vs Frénésie » card, in order. */
export const COMPARISON_PRESETS: readonly { id: PerfPreset; label: string; hint: string }[] = [
  { id: 'young_calm', label: 'Calme', hint: 'Profil d’alertes « Jeune calme » ; portefeuille virtuel Calme (tout à ×2).' },
  { id: 'young_frenzy', label: 'Frénésie', hint: 'Profil témoin sans alerte ; portefeuille virtuel Frénésie (tout à ×2).' },
];

/** Segments of the « Calme vs Frénésie » card (no age split: both presets are < 24 h by construction). */
export const COMPARISON_SEGMENTS: readonly PresetSegment[] = ['all', 'gta', 'other'];

export const SEGMENT_LABEL: Record<PresetSegment, string> = {
  all: 'Tous',
  gta: 'GTA',
  other: 'Hors GTA',
};

const PRESET_IDS: readonly string[] = COMPARISON_PRESETS.map((p) => p.id);

export function isPerfPreset(v: unknown): v is PerfPreset {
  return typeof v === 'string' && PRESET_IDS.includes(v);
}

/** Finite number (PostgREST numerics may arrive as text) or null; anything else → undefined (invalid). */
function parseSol(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Optional count: null / absent → 0, otherwise a non-negative integer (else invalid). */
function parseOptionalCount(v: unknown): number | null {
  return v === null || v === undefined ? 0 : parseCount(v);
}

/**
 * Defensive parse of one row: unknown preset or segment (removed presets and age segments included), a missing or
 * malformed count, inconsistent counts (labelled > signals, both orders above labelled) or a non-numeric P&L → null.
 */
export function parsePresetRow(value: unknown): PresetRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const preset = r['preset'];
  const segment = r['segment'];
  if (!isPerfPreset(preset) || !isComparisonSegment(segment)) return null;
  const signals = parseCount(r['signals']);
  const labelled = parseCount(r['labelled']);
  const x2 = parseCount(r['x2_before_sl30']);
  const sl = parseCount(r['sl30_before_x2']);
  const trades = parseOptionalCount(r['trades']);
  const open = parseOptionalCount(r['paper_open']);
  if (signals === null || labelled === null || x2 === null || sl === null || trades === null || open === null) return null;
  if (labelled > signals || x2 + sl > labelled) return null;
  const sim = parseSol(r['sim_pnl_sol']);
  const paper = parseSol(r['paper_pnl_sol']);
  if (sim === undefined || paper === undefined) return null;
  return {
    preset,
    segment,
    signals,
    labelled,
    x2_before_sl30: x2,
    sl30_before_x2: sl,
    sim_pnl_sol: sim,
    trades,
    paper_pnl_sol: paper,
    paper_open: open,
  };
}

/** Valid rows only; a duplicated (preset, segment) keeps the first one. */
export function parsePresetRows(data: unknown): PresetRow[] {
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const rows: PresetRow[] = [];
  for (const raw of data) {
    const row = parsePresetRow(raw);
    if (!row) continue;
    const key = `${row.preset}:${row.segment}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

/** One column of the « Calme vs Frénésie » card. */
export interface PresetCardView {
  preset: PerfPreset;
  label: string;
  hint: string;
  segment: PresetSegment;
  /** null: no row for this preset / segment yet. */
  row: PresetRow | null;
  /** labelled ≥ 30: the two rates may be shown prominently (same rule as the breakdown). */
  enough: boolean;
  /** Shape accepted by <app-bucket-rates> (n = labelled). */
  rates: RateCell[];
  n: number;
}

/** Everything one column shows for the selected segment (unknown segment → « Tous »). */
export function presetCardView(rows: readonly PresetRow[], preset: PerfPreset, segment: PresetSegment): PresetCardView {
  const def = COMPARISON_PRESETS.find((p) => p.id === preset) ?? COMPARISON_PRESETS[0];
  const seg = isComparisonSegment(segment) ? segment : 'all';
  const row = rows.find((r) => r.preset === preset && r.segment === seg) ?? null;
  const n = row?.labelled ?? 0;
  const rate = (hits: number) => (n > 0 ? hits / n : null);
  return {
    preset,
    label: def!.label,
    hint: def!.hint,
    segment: seg,
    row,
    enough: hasEnoughSample(n),
    n,
    rates: row
      ? [
          { key: 'x2_before_sl30', label: '×2 avant stop (−30 %)', tone: 'bull', hits: row.x2_before_sl30, rate: rate(row.x2_before_sl30) },
          { key: 'sl30_before_x2', label: 'Stop (−30 %) avant ×2', tone: 'bear', hits: row.sl30_before_x2, rate: rate(row.sl30_before_x2) },
        ]
      : [],
  };
}

export function isComparisonSegment(v: unknown): v is PresetSegment {
  return typeof v === 'string' && (COMPARISON_SEGMENTS as readonly string[]).includes(v);
}

export interface ComparisonView {
  segment: PresetSegment;
  segments: readonly { id: PresetSegment; label: string }[];
  /** Calme then Frénésie, for the selected segment. */
  columns: PresetCardView[];
  /** At least one column has a row for this segment. */
  hasData: boolean;
}

/** « Calme vs Frénésie » for one shared segment (unknown segment → « Tous »). */
export function comparisonView(rows: readonly PresetRow[], segment: PresetSegment): ComparisonView {
  const seg = isComparisonSegment(segment) ? segment : 'all';
  const columns = COMPARISON_PRESETS.map((p) => presetCardView(rows, p.id, seg));
  return {
    segment: seg,
    segments: COMPARISON_SEGMENTS.map((id) => ({ id, label: SEGMENT_LABEL[id] })),
    columns,
    hasData: columns.some((c) => c.row !== null),
  };
}

export interface ComparisonCell {
  /** Main text (rate in % only from 30 labelled signals, otherwise « hits / n »). */
  text: string;
  /** Second line (« hits / n » under a prominent rate); null when none. */
  sub: string | null;
  /** Under 30 labelled signals (or no data): muted, never coloured. */
  muted: boolean;
  tone: 'bull' | 'bear' | null;
}

export interface ComparisonRow {
  key: 'labelled' | 'x2_before_sl30' | 'sl30_before_x2' | 'trades' | 'paper_pnl' | 'paper_open';
  label: string;
  cells: ComparisonCell[];
}

const EMPTY_CELL: ComparisonCell = { text: '—', sub: null, muted: true, tone: null };

function rateCell(c: PresetCardView, hits: number, tone: 'bull' | 'bear'): ComparisonCell {
  const n = c.n;
  if (!c.enough) return { text: formatHits(hits, n), sub: n > 0 ? formatRate(hits / n) : null, muted: true, tone: null };
  return { text: formatRate(hits / n), sub: formatHits(hits, n), muted: false, tone };
}

/** Rows of the « Calme vs Frénésie » table, one cell per column (« — » when a column has no row). */
export function comparisonRows(view: ComparisonView): ComparisonRow[] {
  const per = (f: (c: PresetCardView, r: PresetRow) => ComparisonCell): ComparisonCell[] =>
    view.columns.map((c) => (c.row ? f(c, c.row) : EMPTY_CELL));
  const plain = (text: string): ComparisonCell => ({ text, sub: null, muted: false, tone: null });
  return [
    {
      key: 'labelled',
      label: 'Signaux étiquetés',
      cells: per((c, r) => ({ text: formatCount(r.labelled), sub: `sur ${formatCount(r.signals)}`, muted: !c.enough, tone: null })),
    },
    { key: 'x2_before_sl30', label: '×2 avant stop (−30 %)', cells: per((c, r) => rateCell(c, r.x2_before_sl30, 'bull')) },
    { key: 'sl30_before_x2', label: 'Stop (−30 %) avant ×2', cells: per((c, r) => rateCell(c, r.sl30_before_x2, 'bear')) },
    { key: 'trades', label: 'Trades virtuels clôturés', cells: per((_c, r) => plain(formatCount(r.trades))) },
    {
      key: 'paper_pnl',
      label: 'P&L virtuel réalisé',
      cells: per((_c, r) => (r.paper_pnl_sol === null ? { ...EMPTY_CELL, text: 'Aucun portefeuille' } : plain(formatSignedSol(r.paper_pnl_sol)))),
    },
    { key: 'paper_open', label: 'Positions ouvertes', cells: per((_c, r) => plain(formatCount(r.paper_open))) },
  ];
}
