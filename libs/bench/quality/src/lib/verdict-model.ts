import type { RiskFacts } from '@raijin/shared-contracts';
import { RISK_ENGINE_VERSION, canIssueVerdict, evaluateRisk } from '@raijin/shared-risk-engine';
import {
  FOLLOW_UP_HORIZONS,
  FOLLOW_UP_WINDOWS,
  classifyObservation,
  resolveOutcomes,
  verdictRecordSchema,
  type EngineVariant,
  type FollowUpHorizon,
  type FollowUpObservation,
  type OutcomeClassification,
  type VerdictRecord,
} from '@raijin/bench-verdicts';

/**
 * Mesure du RISQUE (PROMPT.md §4.8, ARCHITECTURE §16) : enregistrement des verdicts du moteur publié de Raijin sur les
 * détections du banc, observations à 24 h / 72 h / 7 j, agrégats quotidiens. Fonctions pures (aucune I/O, `now` en
 * paramètre) ; le job `verdict-follow-up` les appelle avec la base et les sources du banc.
 */

/** Lecture de marché d'un mint (DexScreener : meilleure paire Solana) ; `null` partout = source indisponible. */
export interface MarketReading {
  /** `false` : DexScreener a répondu sans aucune paire ; `null` : pas de réponse. */
  readonly poolFound: boolean | null;
  readonly priceUsd: number | null;
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
}

export const UNKNOWN_MARKET: MarketReading = { poolFound: null, priceUsd: null, liquidityUsd: null, volume24hUsd: null };

/** Ligne `verdict_records` à insérer (colonnes SQL). */
export interface VerdictRow {
  readonly mint: string;
  readonly verdict_at: string;
  readonly engine_version: string;
  readonly verdict: 'safe' | 'warn' | 'danger';
  readonly reason_codes: string[];
  readonly flagged_checks: string[];
  readonly baseline_price_usd: number | null;
  readonly baseline_liquidity_usd: number | null;
  readonly baseline_supply_raw: string | null;
  readonly facts: RiskFacts;
  readonly facts_version: string;
}

const finiteOrNull = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const rawOrNull = (v: string | null | undefined): string | null => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : null);

/**
 * Verdict du moteur **publié** (`evaluateRisk`, configuration par défaut) sur des faits collectés. `null` si le moteur
 * ne peut pas conclure (`canIssueVerdict` faux : autorités inconnues, règle D1) : rien n'est enregistré.
 */
export function buildVerdictRow(facts: RiskFacts, market: MarketReading, supplyRaw: string | null): VerdictRow | null {
  if (!canIssueVerdict(facts)) return null;
  const assessment = evaluateRisk(facts);
  return {
    mint: facts.mint,
    verdict_at: new Date(facts.observedAt).toISOString(),
    engine_version: RISK_ENGINE_VERSION,
    verdict: assessment.verdict,
    reason_codes: [...new Set(assessment.reasons.map((r) => r.code))].slice(0, 40),
    flagged_checks: assessment.checks.filter((c) => c.status === 'warn' || c.status === 'danger').map((c) => c.id).slice(0, 9),
    baseline_price_usd: finiteOrNull(market.priceUsd),
    baseline_liquidity_usd: finiteOrNull(facts.liquidity?.usd ?? market.liquidityUsd),
    baseline_supply_raw: rawOrNull(supplyRaw),
    facts,
    facts_version: String(facts.version),
  };
}

/** Ligne SQL (`json_agg`) → `VerdictRecord` du contrat ; `null` si hors contrat (ligne écartée, jamais devinée). */
export function toVerdictRecord(row: Record<string, unknown>): VerdictRecord | null {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const parsed = verdictRecordSchema.safeParse({
    id: String(row['id']),
    mint: row['mint'],
    verdictAt: typeof row['verdict_at'] === 'string' ? new Date(row['verdict_at']).toISOString() : row['verdict_at'],
    engineVersion: row['engine_version'],
    verdict: row['verdict'],
    reasonCodes: row['reason_codes'],
    flaggedChecks: row['flagged_checks'],
    baseline: {
      priceUsd: num(row['baseline_price_usd']),
      liquidityUsd: num(row['baseline_liquidity_usd']),
      supplyRaw: row['baseline_supply_raw'] === null || row['baseline_supply_raw'] === undefined ? null : BigInt(String(row['baseline_supply_raw']).split('.')[0] ?? '0').toString(),
    },
    facts: row['facts'],
  });
  return parsed.success ? parsed.data : null;
}

export function toObservation(row: Record<string, unknown>): FollowUpObservation | null {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const observedAt = typeof row['observed_at'] === 'string' ? new Date(row['observed_at']).toISOString() : null;
  if (observedAt === null) return null;
  return {
    recordId: String(row['record_id']),
    horizon: row['horizon'] as FollowUpHorizon,
    observedAt,
    poolFound: (row['pool_found'] as boolean | null) ?? null,
    lpRemoved: (row['lp_removed'] as boolean | null) ?? null,
    priceUsd: num(row['price_usd']),
    liquidityUsd: num(row['liquidity_usd']),
    volume24hUsd: num(row['volume_24h_usd']),
    supplyRaw: row['supply_raw'] === null || row['supply_raw'] === undefined ? null : BigInt(String(row['supply_raw']).split('.')[0] ?? '0').toString(),
  };
}

/** Bornes de la fenêtre d'observation ouverte à `now` pour `horizon` : verdicts émis dans `[from ; to]`. */
export function dueWindow(horizon: FollowUpHorizon, now: Date): { readonly from: string; readonly to: string } {
  const w = FOLLOW_UP_WINDOWS[horizon];
  return {
    from: new Date(now.getTime() - w.afterMs - w.toleranceMs).toISOString(),
    to: new Date(now.getTime() - w.afterMs).toISOString(),
  };
}

/** Observation d'un verdict à un horizon, classée (statut et événements stockés avec la ligne). */
export function buildObservation(
  record: VerdictRecord,
  horizon: FollowUpHorizon,
  market: MarketReading,
  supplyRaw: string | null,
  now: Date,
): { readonly observation: FollowUpObservation; readonly classification: OutcomeClassification | null } {
  const observation: FollowUpObservation = {
    recordId: record.id,
    horizon,
    observedAt: now.toISOString(),
    poolFound: market.poolFound,
    // Non mesuré par la relève (la chute de liquidité au-delà du seuil couvre le retrait de LP, ARCHITECTURE §16.2).
    lpRemoved: null,
    priceUsd: finiteOrNull(market.priceUsd),
    liquidityUsd: finiteOrNull(market.liquidityUsd),
    volume24hUsd: finiteOrNull(market.volume24hUsd),
    supplyRaw: rawOrNull(supplyRaw),
  };
  return { observation, classification: classifyObservation(record, observation) };
}

/** Ligne `daily_verdict_metrics` (jour UTC du verdict × version × horizon × verdict × issue). */
export interface DailyMetricRow {
  readonly day: string;
  readonly engine_version: string;
  readonly horizon: FollowUpHorizon;
  readonly verdict: 'safe' | 'warn' | 'danger';
  readonly outcome_status: 'rug' | 'dead' | 'alive' | 'unknown';
  readonly n: number;
  /** Nombre de verdicts portant chaque code de raison / contrôle signalé (pouvoir prédictif). */
  readonly signal_counts: Record<string, number>;
}

/**
 * Agrégats quotidiens (calculés avant la purge, ARCHITECTURE §16.5) : issue cumulative de chaque verdict à chaque
 * horizon (`resolveOutcomes`), comptée par jour de verdict. Les `unknown` sont comptés (affichés, exclus des taux).
 */
export function aggregateDaily(records: readonly VerdictRecord[], observations: readonly FollowUpObservation[]): DailyMetricRow[] {
  const rows = new Map<string, { row: Omit<DailyMetricRow, 'n' | 'signal_counts'>; n: number; signals: Record<string, number> }>();
  for (const horizon of FOLLOW_UP_HORIZONS) {
    const resolved = resolveOutcomes(records, observations, horizon);
    for (const record of records) {
      const status = resolved.byRecord.get(record.id)?.status ?? 'unknown';
      const day = record.verdictAt.slice(0, 10);
      const key = [day, record.engineVersion, horizon, record.verdict, status].join('|');
      const entry = rows.get(key) ?? {
        row: { day, engine_version: record.engineVersion, horizon, verdict: record.verdict, outcome_status: status },
        n: 0,
        signals: {},
      };
      entry.n += 1;
      for (const code of [...record.reasonCodes, ...record.flaggedChecks.map((c) => `check:${c}`)]) entry.signals[code] = (entry.signals[code] ?? 0) + 1;
      rows.set(key, entry);
    }
  }
  return [...rows.values()].map(({ row, n, signals }) => ({ ...row, n, signal_counts: signals }));
}

/** Ligne `engine_variants` → `EngineVariant` (drapeau `enabled` déjà filtré par la requête). */
export function toVariant(row: Record<string, unknown>): EngineVariant | null {
  const id = row['id'];
  const label = row['label'];
  const overrides = row['overrides'];
  if (typeof id !== 'string' || typeof label !== 'string' || typeof overrides !== 'object' || overrides === null) return null;
  const weights = row['reason_weights'];
  return {
    id,
    label,
    overrides: overrides as Record<string, number>,
    ...(weights && typeof weights === 'object' ? { reasonWeights: weights as EngineVariant['reasonWeights'] } : {}),
  };
}
