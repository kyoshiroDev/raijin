import {
  VERDICT_SEVERITY_RANK,
  WATCH_SNAPSHOT_VERSION,
  type AuthoritiesSnapshot,
  type HoldersSnapshot,
  type PoolSnapshot,
  type VerdictSnapshot,
  type WatchEvent,
  type WatchSnapshot,
} from '@raijin/shared-contracts';

/**
 * Événements de suivi (PROMPT.md §4.2, docs/ARCHITECTURE.md §11.5, §11.6) : comparaison pure et
 * déterministe de deux instantanés d'un mint (aucune horloge, aucune I/O). Règles et justification
 * des seuils : docs/SCORING.md, section « Événements de suivi ». Toute modification d'une règle ou
 * d'un seuil par défaut change cette version (semver).
 */
export const WATCH_RULES_VERSION = '1.0.0';

const HOUR_MS = 3_600_000;
/** Nombre maximal de raisons reprises dans la charge utile `verdict_degraded` (contrat : 8). */
const MAX_PAYLOAD_REASONS = 8;

/** Seuils des règles (configurables pour le banc : `{ ...WATCH_EVENT_THRESHOLDS, lpDropPct: 40 }`). */
export interface WatchEventThresholds {
  /** Baisse de √(base × quote) du pool suivi, par rapport à la référence, au-delà de laquelle la LP est « retirée » (%). */
  readonly lpDropPct: number;
  /** Fenêtre du plus haut de référence de √(base × quote) (heures). */
  readonly lpReferenceWindowHours: number;
  /** Part minimale de l'offre détenue (avant) pour qu'un holder soit surveillé (%). */
  readonly holderMinPct: number;
  /** Part de sa position qu'un holder doit céder pour déclencher l'alerte (%)… */
  readonly holderSellMinPositionPct: number;
  /** … ou baisse minimale de sa part de l'offre (points de pourcentage). */
  readonly holderSellMinSupplyPts: number;
  /**
   * DEX à courbe de liaison (identifiants DexScreener) : leurs réserves bougent à chaque achat ou
   * vente et la migration vide la courbe ; la règle LP ne s'y applique pas (changement de pool sans alerte).
   */
  readonly bondingCurveDexIds: readonly string[];
}

export const WATCH_EVENT_THRESHOLDS: WatchEventThresholds = {
  lpDropPct: 30,
  lpReferenceWindowHours: 6,
  holderMinPct: 5,
  holderSellMinPositionPct: 25,
  holderSellMinSupplyPts: 1,
  bondingCurveDexIds: ['pumpfun', 'launchlab', 'moonshot'],
};

/** Lecture d'un pool par une passe (sans la référence, calculée par `mergeWatchSnapshot`). */
export type PoolReading = Omit<PoolSnapshot, 'peakSqrtK' | 'peakAt'>;

/**
 * Lecture des pools d'un mint par la passe rapide : `main` = pool principal du moment (plus forte
 * liquidité, `null` si aucun pool listé) ; `tracked` = le pool déjà suivi s'il diffère du principal
 * (relu par son adresse), `null` s'il n'est plus listé.
 */
export interface PoolObservation {
  readonly main: PoolReading | null;
  readonly tracked?: PoolReading | null;
}

/**
 * Résultat d'une passe pour un mint. Par groupe : absent (`undefined`) = non collecté par cette
 * passe ; `null` = source indisponible ; valeur = nouvelle observation. Dans les deux premiers cas,
 * le groupe précédent est conservé tel quel (aucune comparaison, donc aucune fausse alerte).
 */
export interface WatchObservation {
  readonly mint: string;
  readonly authorities?: AuthoritiesSnapshot | null;
  readonly pool?: PoolObservation | null;
  readonly holders?: HoldersSnapshot | null;
  readonly verdict?: VerdictSnapshot | null;
}

function time(iso: string): number {
  return Date.parse(iso);
}

function isNewer(next: { observedAt: string }, previous: { observedAt: string } | null): boolean {
  return previous === null || time(next.observedAt) > time(previous.observedAt);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, round2(value)));
}

function isBondingCurve(pool: { dex: string }, thresholds: WatchEventThresholds): boolean {
  return thresholds.bondingCurveDexIds.includes(pool.dex);
}

/**
 * Référence LP : plus haut mémorisé s'il date de moins de `lpReferenceWindowHours` à l'instant
 * `at`, sinon la dernière mesure (un seul instantané est gardé : approximation documentée).
 */
export function lpReference(pool: PoolSnapshot, at: string, thresholds: WatchEventThresholds = WATCH_EVENT_THRESHOLDS) {
  const windowStart = time(at) - thresholds.lpReferenceWindowHours * HOUR_MS;
  return time(pool.peakAt) >= windowStart
    ? { sqrtK: pool.peakSqrtK, at: pool.peakAt }
    : { sqrtK: pool.sqrtK, at: pool.observedAt };
}

/** Baisse (%) de `current` par rapport à `reference` (0 si la référence est nulle). */
function dropPct(reference: number, current: number): number {
  return reference > 0 ? clampPct((1 - current / reference) * 100) : 0;
}

function freshPool(reading: PoolReading): PoolSnapshot {
  return { ...reading, peakSqrtK: reading.sqrtK, peakAt: reading.observedAt };
}

/** Pool suivi relu : plus haut mis à jour, ou remis au niveau courant après une baisse alertée. */
function continuePool(previous: PoolSnapshot, reading: PoolReading, thresholds: WatchEventThresholds): PoolSnapshot {
  const reference = lpReference(previous, reading.observedAt, thresholds);
  const dropped = dropPct(reference.sqrtK, reading.sqrtK) > thresholds.lpDropPct;
  if (dropped || reading.sqrtK >= reference.sqrtK) return freshPool(reading);
  return { ...reading, peakSqrtK: reference.sqrtK, peakAt: reference.at };
}

function mergePool(previous: PoolSnapshot | null, observation: PoolObservation, thresholds: WatchEventThresholds): PoolSnapshot | null {
  const { main } = observation;
  const tracked = observation.tracked ?? null;
  if (previous === null) {
    const first = main ?? tracked;
    return first === null ? null : freshPool(first);
  }
  const same = [tracked, main].find((reading): reading is PoolReading => reading !== null && reading.address === previous.address);
  if (same !== undefined) {
    if (!isNewer(same, previous)) return previous;
    const switchTo = main !== null && main.address !== previous.address ? main : null;
    if (switchTo !== null) {
      // Courbe de liaison : on suit le pool principal (migration, pas un retrait).
      if (isBondingCurve(previous, thresholds)) return freshPool(switchTo);
      // Pool principal changé sans baisse alertable du pool suivi : nouvelle référence.
      const reference = lpReference(previous, same.observedAt, thresholds);
      const dropped = dropPct(reference.sqrtK, same.sqrtK) > thresholds.lpDropPct;
      if (!dropped && (switchTo.liquidityUsd ?? 0) > (same.liquidityUsd ?? 0)) return freshPool(switchTo);
    }
    return continuePool(previous, same, thresholds);
  }
  // Pool suivi plus listé : nouveau pool principal comme référence (jamais d'alerte au changement).
  if (main !== null && isNewer(main, previous)) return freshPool(main);
  return previous;
}

function pick<T extends { observedAt: string }>(previous: T | null, next: T | null | undefined): T | null {
  if (next === undefined || next === null) return previous;
  return isNewer(next, previous) ? next : previous;
}

/**
 * Nouvel instantané d'un mint à partir du précédent et d'une observation partielle. Les groupes
 * absents ou indisponibles sont conservés ; une observation plus ancienne que le groupe stocké est
 * ignorée (passe rejouée). Pour la LP : sélection du pool suivi et plus haut glissant (`peakSqrtK`).
 */
export function mergeWatchSnapshot(
  previous: WatchSnapshot | null,
  observation: WatchObservation,
  thresholds: WatchEventThresholds = WATCH_EVENT_THRESHOLDS,
): WatchSnapshot {
  const base = previous !== null && previous.mint === observation.mint ? previous : null;
  const pool =
    observation.pool === undefined || observation.pool === null
      ? (base?.pool ?? null)
      : mergePool(base?.pool ?? null, observation.pool, thresholds);
  return {
    version: WATCH_SNAPSHOT_VERSION,
    mint: observation.mint,
    authorities: pick(base?.authorities ?? null, observation.authorities),
    pool,
    holders: pick(base?.holders ?? null, observation.holders),
    verdict: pick(base?.verdict ?? null, observation.verdict),
  };
}

function majorOf(version: string): string {
  return version.split('.')[0] ?? version;
}

function verdictEvent(previous: VerdictSnapshot, next: VerdictSnapshot): WatchEvent | null {
  if (!isNewer(next, previous)) return null;
  // Changement de version majeure du moteur : nouvelle référence, sans alerte (règles différentes).
  if (majorOf(previous.engineVersion) !== majorOf(next.engineVersion)) return null;
  if (VERDICT_SEVERITY_RANK[next.verdict] <= VERDICT_SEVERITY_RANK[previous.verdict]) return null;
  return {
    type: 'verdict_degraded',
    payload: {
      from: previous.verdict,
      to: next.verdict,
      reasonCodes: next.reasonCodes.slice(0, MAX_PAYLOAD_REASONS),
      analysisId: next.analysisId,
    },
    severity: next.verdict === 'danger' ? 'danger' : 'warn',
    dedupeKey: `verdict_degraded:${previous.verdict}>${next.verdict}:${next.analysisId ?? next.observedAt}`,
    detectedAt: next.observedAt,
  };
}

function authorityEvents(previous: AuthoritiesSnapshot, next: AuthoritiesSnapshot): WatchEvent[] {
  if (!isNewer(next, previous)) return [];
  const events: WatchEvent[] = [];
  const payload = { revokedObservedAt: previous.observedAt };
  if (!previous.mintAuthorityActive && next.mintAuthorityActive) {
    events.push({
      type: 'mint_reactivated',
      payload,
      severity: 'danger',
      dedupeKey: `mint_reactivated:${next.observedAt}`,
      detectedAt: next.observedAt,
    });
  }
  if (!previous.freezeAuthorityActive && next.freezeAuthorityActive) {
    events.push({
      type: 'freeze_reactivated',
      payload,
      severity: 'danger',
      dedupeKey: `freeze_reactivated:${next.observedAt}`,
      detectedAt: next.observedAt,
    });
  }
  return events;
}

function poolEvent(previous: PoolSnapshot, next: PoolSnapshot, thresholds: WatchEventThresholds): WatchEvent | null {
  if (previous.address !== next.address || !isNewer(next, previous) || isBondingCurve(previous, thresholds)) return null;
  const reference = lpReference(previous, next.observedAt, thresholds);
  const drop = dropPct(reference.sqrtK, next.sqrtK);
  if (!(drop > thresholds.lpDropPct)) return null;
  return {
    type: 'lp_removed',
    payload: {
      poolAddress: previous.address,
      dex: previous.dex,
      dropPct: drop,
      liquidityUsdBefore: previous.liquidityUsd,
      liquidityUsdAfter: next.liquidityUsd,
      referenceAt: reference.at,
    },
    severity: 'danger',
    dedupeKey: `lp_removed:${previous.address}:${reference.at}`,
    detectedAt: next.observedAt,
  };
}

/** Montant brut agrégé par propriétaire (un holder peut avoir plusieurs comptes de token). */
function byOwner(holders: HoldersSnapshot): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const entry of holders.top) totals.set(entry.owner, (totals.get(entry.owner) ?? 0n) + BigInt(entry.amount));
  return totals;
}

/** Part de l'offre (%) d'un montant brut, à 4 décimales. */
function shareOf(amount: bigint, supply: bigint): number {
  if (supply <= 0n) return 0;
  return Math.min(100, Number((amount * 1_000_000n) / supply) / 10_000);
}

function holderEvents(previous: HoldersSnapshot, next: HoldersSnapshot, thresholds: WatchEventThresholds): WatchEvent[] {
  if (!isNewer(next, previous)) return [];
  // Top vide après un top non vide : lecture douteuse (tous les comptes exclus ?), aucune alerte.
  if (next.top.length === 0) return [];
  const before = byOwner(previous);
  const after = byOwner(next);
  const previousSupply = BigInt(previous.supply);
  const nextSupply = BigInt(next.supply);
  // Sorti du top : sa position est au plus celle du plus petit compte encore listé (borne prudente).
  const floor = next.top.reduce((min, entry) => {
    const amount = BigInt(entry.amount);
    return min === null || amount < min ? amount : min;
  }, null as bigint | null) as bigint;

  const events: WatchEvent[] = [];
  for (const [owner, amountBefore] of before) {
    const beforePct = shareOf(amountBefore, previousSupply);
    if (beforePct < thresholds.holderMinPct || amountBefore === 0n) continue;
    const listed = after.get(owner);
    const amountAfter = listed ?? (floor < amountBefore ? floor : amountBefore);
    if (amountAfter >= amountBefore) continue;
    const soldPctOfPosition = clampPct(Number(((amountBefore - amountAfter) * 1_000_000n) / amountBefore) / 10_000);
    const afterPct = listed === undefined ? null : round2(shareOf(listed, nextSupply));
    const supplyPts = beforePct - (afterPct ?? shareOf(amountAfter, nextSupply));
    if (soldPctOfPosition < thresholds.holderSellMinPositionPct && supplyPts < thresholds.holderSellMinSupplyPts) continue;
    events.push({
      type: 'holder_sold',
      payload: { owner, beforePct: round2(beforePct), afterPct, soldPctOfPosition },
      severity: 'warn',
      dedupeKey: `holder_sold:${owner}:${previous.observedAt}`,
      detectedAt: next.observedAt,
    });
  }
  return events;
}

/**
 * Événements entre deux instantanés d'un même mint (`next` = résultat de `mergeWatchSnapshot`).
 * Première observation d'un groupe (`previous` ou groupe précédent `null`) : référence, jamais
 * d'alerte. Groupe inchangé (même `observedAt`, source indisponible) : aucune comparaison.
 * Ordre stable : verdict, mint, freeze, LP, holders (par ordre du top précédent).
 */
export function detectWatchEvents(
  previous: WatchSnapshot | null,
  next: WatchSnapshot,
  thresholds: WatchEventThresholds = WATCH_EVENT_THRESHOLDS,
): WatchEvent[] {
  if (previous === null || previous.mint !== next.mint) return [];
  const events: WatchEvent[] = [];
  if (previous.verdict !== null && next.verdict !== null) {
    const event = verdictEvent(previous.verdict, next.verdict);
    if (event !== null) events.push(event);
  }
  if (previous.authorities !== null && next.authorities !== null) {
    events.push(...authorityEvents(previous.authorities, next.authorities));
  }
  if (previous.pool !== null && next.pool !== null) {
    const event = poolEvent(previous.pool, next.pool, thresholds);
    if (event !== null) events.push(event);
  }
  if (previous.holders !== null && next.holders !== null) {
    events.push(...holderEvents(previous.holders, next.holders, thresholds));
  }
  return events;
}
