// Nightly summary of a backtest run (backtest_runs.summary jsonb, docs/contracts/lab-v2.md §3), parsed defensively
// and turned into fixed French copy. The server `text` is only a fallback (control characters removed, capped):
// the banner is rebuilt from the structured fields so the wording stays consistent.
import { formatSignedPercentFr } from '../../shared/utils/format';
import {
  NARRATIVES,
  count,
  first,
  isLabNarrative,
  isLabPreset,
  isoDate,
  num,
  parseVariantKey,
  record,
  variantName,
  type BacktestRun,
  type LabNarrative,
  type VariantKey,
} from './backtest';
import { formatCi, formatInt, formatLabDate } from './lab-format';

export interface SummarySplit {
  trades: number | null;
  avgNetPct: number | null;
}

export interface SummaryTestSplit extends SummarySplit {
  ciLow: number | null;
  ciHigh: number | null;
}

export interface SummaryCandidate {
  key: VariantKey;
  narrative: LabNarrative;
  test: SummaryTestSplit;
  train: SummarySplit;
}

export interface LabSummary {
  verdict: 'none' | 'candidate';
  runAt: string | null;
  nDetections: number | null;
  nEvents: number | null;
  /** null when verdict = 'none', or when the candidate block is unreadable (then `text` is shown). */
  candidate: SummaryCandidate | null;
  /** Server text, cleaned (fallback only). */
  text: string | null;
}

export interface SummaryView {
  verdict: 'none' | 'candidate';
  title: string;
  /** Test then training lines (candidate only). */
  details: string[];
  /** « Backtest du 19 nov., 04:10 · 600 détections + 120 événements ». */
  meta: string;
}

const TEXT_MAX = 300;

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const clean = v
    .replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length === 0) return null;
  return clean.length > TEXT_MAX ? `${clean.slice(0, TEXT_MAX - 1)}…` : clean;
}

function parseSplit(v: unknown): SummarySplit {
  const r = record(v) ?? {};
  return { trades: count(r['trades']), avgNetPct: num(r['avg_net_pct']) };
}

function parseCandidate(v: unknown): SummaryCandidate | null {
  const r = record(v);
  if (!r) return null;
  const key = parseVariantKey(r);
  if (!key) return null;
  const narrative = r['narrative'] ?? 'all';
  if (!isLabNarrative(narrative)) return null;
  const test = record(r['test']) ?? {};
  return {
    key,
    narrative,
    test: { ...parseSplit(test), ciLow: num(test['ci_low']), ciHigh: num(test['ci_high']) },
    train: parseSplit(r['train']),
  };
}

/** The candidate block names a preset this lab no longer shows (removed or exploratory), even if the rest is unreadable. */
function namesRemovedPreset(v: unknown): boolean {
  const preset = record(v)?.['preset'];
  return typeof preset === 'string' && !isLabPreset(preset);
}

/**
 * Defensive parse of backtest_runs.summary; null when absent, with an unknown verdict, or when the candidate is a
 * variant of a preset that is no longer shown (never presented as a candidate, so the banner is not shown at all).
 */
export function parseSummary(value: unknown): LabSummary | null {
  const r = record(value);
  if (!r) return null;
  const verdict = r['verdict'];
  if (verdict !== 'none' && verdict !== 'candidate') return null;
  if (verdict === 'candidate' && namesRemovedPreset(r['candidate'])) return null;
  return {
    verdict,
    runAt: isoDate(r['run_at']),
    nDetections: count(first(r, ['n_detections', 'detections'])),
    nEvents: count(first(r, ['n_events', 'events'])),
    candidate: verdict === 'candidate' ? parseCandidate(r['candidate']) : null,
    text: cleanText(r['text']),
  };
}

const NARRATIVE_LABEL = new Map(NARRATIVES.map((n) => [n.id, n.label]));

const plural = (n: number | null, word: string): string =>
  `${formatInt(n)} ${word}${n !== null && n > 1 ? 's' : ''}`;

function splitLine(label: string, s: SummarySplit): string {
  return `${label} : ${plural(s.trades, 'trade')}, gain moyen net ${formatSignedPercentFr(s.avgNetPct)}`;
}

/** French banner copy; the run fills the date and sample size when the summary omits them. */
export function summaryView(summary: LabSummary, run: BacktestRun | null = null): SummaryView {
  const detections = summary.nDetections ?? run?.nDetections ?? run?.data.detections ?? null;
  const events = summary.nEvents ?? run?.data.events ?? null;
  const sample =
    events === null
      ? plural(detections, 'détection')
      : `${plural(detections, 'détection')} + ${plural(events, 'événement')}`;
  const meta = `Backtest du ${formatLabDate(summary.runAt ?? run?.finishedAt ?? run?.createdAt ?? null)} · ${sample}`;
  if (summary.verdict === 'none')
    return { verdict: 'none', title: 'Aucune stratégie robuste', details: [], meta };
  const c = summary.candidate;
  if (!c) {
    return {
      verdict: 'candidate',
      title: 'Stratégie candidate',
      details: summary.text ? [summary.text] : [],
      meta,
    };
  }
  const narrative = c.narrative === 'all' ? '' : ` · ${NARRATIVE_LABEL.get(c.narrative) ?? ''}`;
  return {
    verdict: 'candidate',
    title: `Stratégie candidate : ${variantName(c.key)}${narrative}`,
    details: [
      `${splitLine('Test', c.test)}, IC 95 % ${formatCi(c.test.ciLow, c.test.ciHigh)}`,
      splitLine('Apprentissage', c.train),
    ],
    meta,
  };
}
