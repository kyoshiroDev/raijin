import type { UpstreamError, UpstreamId } from './errors';
import { SILENT_LOGGER, SYSTEM_CLOCK, type Clock, type CreditBudget, type CreditLane, type SolanaLogger } from './ports';

/**
 * Compteurs d'appels par source externe et par jour UTC (ARCHITECTURE.md §14.1, écran admin « Santé technique »).
 * Aucune donnée sensible : ni URL, ni clé, ni mint, ni adresse ; seulement la source, une catégorie fermée, une
 * latence et des crédits.
 */

/** Échecs imputables au fournisseur (comptés dans le taux d'erreur). `other` : 4xx inattendu, erreur JSON-RPC. */
export const UPSTREAM_FAILURE_CATEGORIES = ['timeout', 'rate_limited', 'server_error', 'validation', 'network', 'other'] as const;
export type UpstreamFailureCategory = (typeof UPSTREAM_FAILURE_CATEGORIES)[number];

/**
 * Issues neutres d'une requête émise : `cancelled` (échéance de la collecte ou signal de l'hôte), `oversized`
 * (réponse > 2 Mo : propriété du compte demandé, pas une panne).
 */
export const UPSTREAM_NEUTRAL_OUTCOMES = ['cancelled', 'oversized'] as const;
export type UpstreamNeutralOutcome = (typeof UPSTREAM_NEUTRAL_OUTCOMES)[number];

export type UpstreamCallOutcome = 'success' | UpstreamFailureCategory | UpstreamNeutralOutcome;

/** Appels refusés **avant** toute requête (aucun appel au fournisseur, aucun crédit). */
export const UPSTREAM_REJECTIONS = ['circuit_open', 'queue_full', 'budget_exhausted', 'aborted', 'not_configured'] as const;
export type UpstreamRejection = (typeof UPSTREAM_REJECTIONS)[number];

/**
 * Port d'enregistrement appelé par `UpstreamGate` (chaque tentative, rejeux compris) et par le budget de crédits.
 * Méthodes synchrones, sans exception : l'enregistrement ne ralentit ni ne fait échouer un appel.
 */
export interface SourceUsageRecorder {
  recordCall(source: UpstreamId, outcome: UpstreamCallOutcome, latencyMs: number): void;
  recordRejection(source: UpstreamId, reason: UpstreamRejection): void;
  recordCredits(lane: CreditLane, credits: number): void;
  recordCreditRefusal(lane: CreditLane): void;
}

export const NOOP_USAGE_RECORDER: SourceUsageRecorder = {
  recordCall: () => undefined,
  recordRejection: () => undefined,
  recordCredits: () => undefined,
  recordCreditRefusal: () => undefined,
};

export type UpstreamErrorClass =
  | { readonly kind: 'call'; readonly outcome: Exclude<UpstreamCallOutcome, 'success'> }
  | { readonly kind: 'rejection'; readonly reason: UpstreamRejection };

/** Catégorie d'une `UpstreamError` (fermée : la valeur ne vient jamais du fournisseur). */
export function classifyUpstreamError(error: UpstreamError): UpstreamErrorClass {
  switch (error.kind) {
    case 'timeout':
    case 'rate_limited':
    case 'network':
      return { kind: 'call', outcome: error.kind };
    case 'http_error':
      return { kind: 'call', outcome: error.status !== null && error.status >= 500 ? 'server_error' : 'other' };
    case 'invalid_response':
      return { kind: 'call', outcome: 'validation' };
    case 'rpc_error':
      return { kind: 'call', outcome: 'other' };
    case 'too_large':
      return { kind: 'call', outcome: 'oversized' };
    case 'aborted':
      return { kind: 'call', outcome: 'cancelled' };
    default:
      return { kind: 'rejection', reason: error.kind };
  }
}

// --- Stockage des compteurs ----------------------------------------------------------------------

/**
 * Compteurs journaliers stockés par l'hôte (API : Redis, branché par admin-analytics ; défaut : mémoire).
 * Clés `upstream:calls:<source>:<jour>` et `upstream:credits:<jour>` (hash de champs entiers), TTL 8 jours.
 */
export interface UsageCounterStore {
  /** Ajoute chaque valeur au champ du hash `key` (`HINCRBY`) et (re)pose l'expiration (`EXPIRE`). */
  increment(key: string, fields: Readonly<Record<string, number>>, ttlSeconds: number): Promise<void>;
  /** Lit les hashes (`HGETALL`), dans l'ordre des clés ; `null` ou `{}` pour une clé absente. */
  read(keys: readonly string[]): Promise<ReadonlyArray<Readonly<Record<string, string | number>> | null>>;
}

/** TTL des compteurs : 8 jours (agrégation nocturne J-1 + recalcul J-2 / J-3, marge). */
export const UPSTREAM_USAGE_TTL_S = 8 * 86_400;

const DAY_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** Jour UTC `AAAA-MM-JJ` d'un instant (ms epoch). */
export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Valide un jour UTC fourni par l'appelant (aucune valeur libre n'entre dans une clé). */
export function assertUtcDay(day: string): string {
  if (!DAY_PATTERN.test(day) || utcDay(Date.parse(`${day}T00:00:00Z`)) !== day) throw new RangeError('Jour UTC invalide.');
  return day;
}

export function upstreamCallsKey(source: UpstreamId, day: string): string {
  return `upstream:calls:${source}:${assertUtcDay(day)}`;
}

export function upstreamCreditsKey(day: string): string {
  return `upstream:credits:${assertUtcDay(day)}`;
}

/** Champ de latence cumulée (ms) d'un hash d'appels. */
export const LATENCY_FIELD = 'latency_ms';
const rejectionField = (reason: UpstreamRejection) => `rejected_${reason}`;
const creditField = (lane: CreditLane) => `used_${lane}`;
const refusalField = (lane: CreditLane) => `refused_${lane}`;

/** Stockage mémoire (défaut, propre au processus) : borné, entrées expirées purgées à l'écriture. */
export class MemoryUsageCounterStore implements UsageCounterStore {
  private readonly hashes = new Map<string, { fields: Map<string, number>; expiresAt: number }>();

  constructor(
    private readonly clock: Clock = SYSTEM_CLOCK,
    private readonly maxKeys = 200,
  ) {}

  async increment(key: string, fields: Readonly<Record<string, number>>, ttlSeconds: number): Promise<void> {
    const now = this.clock.now();
    let entry = this.hashes.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.hashes.delete(key);
      this.prune(now);
      entry = { fields: new Map(), expiresAt: 0 };
      this.hashes.set(key, entry);
    }
    for (const [field, value] of Object.entries(fields)) entry.fields.set(field, (entry.fields.get(field) ?? 0) + value);
    entry.expiresAt = now + ttlSeconds * 1_000;
  }

  async read(keys: readonly string[]): Promise<Array<Record<string, number> | null>> {
    const now = this.clock.now();
    return keys.map((key) => {
      const entry = this.hashes.get(key);
      return entry && entry.expiresAt > now ? Object.fromEntries(entry.fields) : null;
    });
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hashes) if (entry.expiresAt <= now) this.hashes.delete(key);
    while (this.hashes.size >= this.maxKeys) {
      const oldest = this.hashes.keys().next().value;
      /* istanbul ignore next -- la boucle ne tourne que si la table n'est pas vide. */
      if (oldest === undefined) break;
      this.hashes.delete(oldest);
    }
  }
}

/** Valeur lue dans le stockage (donnée non fiable) : entier ≥ 0, sinon 0. */
function counter(hash: Readonly<Record<string, string | number>> | null | undefined, field: string): number {
  const raw = hash?.[field];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// --- Enregistreur ------------------------------------------------------------------------------

export interface RawSourceUsage {
  readonly source: UpstreamId;
  readonly outcomes: Readonly<Record<UpstreamCallOutcome, number>>;
  readonly rejections: Readonly<Record<UpstreamRejection, number>>;
  readonly latencyMsTotal: number;
}

export interface RawCreditUsage {
  readonly used: Readonly<Record<CreditLane, number>>;
  readonly refused: Readonly<Record<CreditLane, number>>;
}

export interface RawUsageDay {
  readonly day: string;
  /** `unavailable` : le stockage n'a pas répondu (compteurs à zéro, jamais d'exception). */
  readonly status: 'ok' | 'unavailable';
  readonly sources: readonly RawSourceUsage[];
  readonly credits: RawCreditUsage;
}

const CALL_OUTCOMES: readonly UpstreamCallOutcome[] = ['success', ...UPSTREAM_FAILURE_CATEGORIES, ...UPSTREAM_NEUTRAL_OUTCOMES];
const LANES: readonly CreditLane[] = ['interactive', 'watch', 'wallet'];

/**
 * Enregistreur sur un `UsageCounterStore` : une écriture par événement, non attendue ; une panne du stockage
 * est journalisée (au plus une fois par minute, sans détail) et ignorée.
 */
export class CounterUsageRecorder implements SourceUsageRecorder {
  private lastWarning = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly store: UsageCounterStore,
    private readonly sources: readonly UpstreamId[],
    private readonly clock: Clock = SYSTEM_CLOCK,
    private readonly logger: SolanaLogger = SILENT_LOGGER,
  ) {}

  recordCall(source: UpstreamId, outcome: UpstreamCallOutcome, latencyMs: number): void {
    const latency = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : 0;
    this.write(upstreamCallsKey(source, this.today()), { [outcome]: 1, [LATENCY_FIELD]: latency });
  }

  recordRejection(source: UpstreamId, reason: UpstreamRejection): void {
    this.write(upstreamCallsKey(source, this.today()), { [rejectionField(reason)]: 1 });
  }

  recordCredits(lane: CreditLane, credits: number): void {
    if (!(credits > 0) || !Number.isSafeInteger(credits)) return;
    this.write(upstreamCreditsKey(this.today()), { [creditField(lane)]: credits });
  }

  recordCreditRefusal(lane: CreditLane): void {
    this.write(upstreamCreditsKey(this.today()), { [refusalField(lane)]: 1 });
  }

  /** Compteurs bruts d'un jour UTC (jamais d'exception : `status: 'unavailable'` si le stockage ne répond pas). */
  async read(day: string): Promise<RawUsageDay> {
    assertUtcDay(day);
    const keys = [...this.sources.map((source) => upstreamCallsKey(source, day)), upstreamCreditsKey(day)];
    let hashes: ReadonlyArray<Readonly<Record<string, string | number>> | null> = [];
    let status: RawUsageDay['status'] = 'ok';
    try {
      hashes = await this.store.read(keys);
    } catch {
      status = 'unavailable';
      this.warn('upstream_usage_read_failed');
    }
    const sources = this.sources.map((source, index): RawSourceUsage => {
      const hash = hashes[index];
      return {
        source,
        outcomes: Object.fromEntries(CALL_OUTCOMES.map((outcome) => [outcome, counter(hash, outcome)])) as Record<UpstreamCallOutcome, number>,
        rejections: Object.fromEntries(UPSTREAM_REJECTIONS.map((reason) => [reason, counter(hash, rejectionField(reason))])) as Record<
          UpstreamRejection,
          number
        >,
        latencyMsTotal: counter(hash, LATENCY_FIELD),
      };
    });
    const creditsHash = hashes[this.sources.length];
    return {
      day,
      status,
      sources,
      credits: {
        used: Object.fromEntries(LANES.map((lane) => [lane, counter(creditsHash, creditField(lane))])) as Record<CreditLane, number>,
        refused: Object.fromEntries(LANES.map((lane) => [lane, counter(creditsHash, refusalField(lane))])) as Record<CreditLane, number>,
      },
    };
  }

  private today(): string {
    return utcDay(this.clock.now());
  }

  private write(key: string, fields: Record<string, number>): void {
    let pending: Promise<void>;
    try {
      pending = this.store.increment(key, fields, UPSTREAM_USAGE_TTL_S);
    } catch {
      this.warn('upstream_usage_write_failed');
      return;
    }
    pending.catch(() => this.warn('upstream_usage_write_failed'));
  }

  private warn(event: string): void {
    const now = this.clock.now();
    if (now - this.lastWarning < 60_000) return;
    this.lastWarning = now;
    this.logger.warn(event, {});
  }
}

/** Budget de crédits qui enregistre chaque réservation acceptée (crédits par voie) ou refusée. */
export class UsageRecordingCreditBudget implements CreditBudget {
  constructor(
    private readonly inner: CreditBudget,
    private readonly recorder: SourceUsageRecorder,
  ) {}

  async tryConsume(credits: number, lane: CreditLane): Promise<boolean> {
    const accepted = await this.inner.tryConsume(credits, lane);
    if (accepted) this.recorder.recordCredits(lane, credits);
    else this.recorder.recordCreditRefusal(lane);
    return accepted;
  }
}
