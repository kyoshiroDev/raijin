import type { AnalysisCheckId, RiskFacts } from '@raijin/shared-contracts';
import { RISK_ENGINE_VERSION, evaluateRisk } from '@raijin/shared-risk-engine';
import {
  FOLLOW_UP_HORIZONS,
  FOLLOW_UP_WINDOWS,
  type EngineVariant,
  type FollowUpObservation,
  type OutcomeEvent,
  type VerdictRecord,
} from './contracts';

/**
 * Historique **simulé** et déterministe (même graine → mêmes données) pour l'écran `/justesse`
 * tant que l'API du banc n'existe pas (phase 8 bis). Aucune donnée réelle : mints tirés au hasard,
 * faits construits comme les fixtures du moteur, issues tirées selon un risque latent par profil de
 * token (cohérentes avec les verdicts sans être parfaites). Ces chiffres ne mesurent rien de réel.
 */

/** PRNG mulberry32 : rapide, 32 bits, reproductible (non cryptographique). */
export function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Adresse base58 de 32 octets tirés au hasard (premier octet non nul : 43 ou 44 caractères). */
function randomMint(random: () => number): string {
  let value = 0n;
  for (let i = 0; i < 32; i += 1) {
    const byte = i === 0 ? 1 + Math.floor(random() * 255) : Math.floor(random() * 256);
    value = (value << 8n) | BigInt(byte);
  }
  let text = '';
  while (value > 0n) {
    text = (BASE58[Number(value % 58n)] as string) + text;
    value /= 58n;
  }
  return text;
}

function between(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Profils de tokens simulés : chacun vise des règles précises du moteur (docs/SCORING.md). */
export const SIMULATION_PROFILES = [
  'established',
  'mutable',
  'midLiquidity',
  'concentrated',
  'young',
  'pump',
  'partial',
  'mintActive',
  'freezeActive',
  'honeypot',
] as const;
export type SimulationProfile = (typeof SIMULATION_PROFILES)[number];

interface ProfileRisk {
  readonly weight: number;
  /** Probabilité d'un rug dans les 7 jours. */
  readonly rug: number;
  /** Probabilité d'une mort (sans rug) dans les 7 jours. */
  readonly dead: number;
}

const PROFILE_RISK: Readonly<Record<SimulationProfile, ProfileRisk>> = {
  established: { weight: 20, rug: 0.02, dead: 0.02 },
  mutable: { weight: 10, rug: 0.06, dead: 0.04 },
  midLiquidity: { weight: 10, rug: 0.12, dead: 0.1 },
  concentrated: { weight: 12, rug: 0.25, dead: 0.15 },
  young: { weight: 12, rug: 0.3, dead: 0.25 },
  pump: { weight: 12, rug: 0.45, dead: 0.3 },
  partial: { weight: 6, rug: 0.2, dead: 0.15 },
  mintActive: { weight: 6, rug: 0.55, dead: 0.2 },
  freezeActive: { weight: 5, rug: 0.5, dead: 0.2 },
  honeypot: { weight: 7, rug: 0.7, dead: 0.2 },
};

function pickProfile(random: () => number): SimulationProfile {
  const total = SIMULATION_PROFILES.reduce((sum, profile) => sum + PROFILE_RISK[profile].weight, 0);
  let draw = random() * total;
  for (const profile of SIMULATION_PROFILES) {
    draw -= PROFILE_RISK[profile].weight;
    if (draw < 0) return profile;
  }
  /* v8 ignore next */
  return 'established';
}

const iso = (time: number) => new Date(time).toISOString();

/** Faits d'un token simulé (même forme que `healthyFacts` des fixtures du moteur). */
export function simulateFacts(profile: SimulationProfile, mint: string, observedAt: string, random: () => number): RiskFacts {
  const at = Date.parse(observedAt);
  const liquidityUsd = round(between(random, 150_000, 2_000_000), 0);
  const facts: RiskFacts = {
    version: 1,
    mint,
    observedAt,
    mintAccount: {
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      tokenProgram: 'spl-token',
      extensions: { transferFeeBps: null, permanentDelegate: false, transferHook: false, nonTransferable: false },
    },
    metadata: { mutable: false },
    liquidity: {
      usd: liquidityUsd,
      samples: [{ source: 'dexscreener', usd: liquidityUsd }],
      lpBurnedOrLockedPct: 100,
      lpRemoved: false,
    },
    holders: { top10Pct: round(between(random, 12, 28), 1), maxSingleHolderPct: round(between(random, 2, 8), 1), excludedAccounts: 2 },
    sellSimulation: { routeFound: true, priceImpactPct: round(between(random, 0.05, 1.5)), implicitTaxPct: round(between(random, 0, 2)), testAmountUsd: 100 },
    age: { tokenCreatedAt: iso(at - between(random, 60, 900) * DAY_MS), poolCreatedAt: iso(at - between(random, 40, 800) * DAY_MS) },
    creator: { address: null, tokensLaunched: Math.floor(between(random, 0, 3)), tokensDeadOrRugged: 0 },
    rugcheck: { scoreNormalised: round(between(random, 1, 10), 0), rugged: false, risks: [] },
  };
  const withLiquidity = (usd: number): RiskFacts['liquidity'] => ({
    usd,
    samples: [{ source: 'geckoterminal', usd }],
    lpBurnedOrLockedPct: 100,
    lpRemoved: false,
  });

  switch (profile) {
    case 'established':
      return facts;
    case 'mutable':
      return { ...facts, metadata: { mutable: true }, rugcheck: { scoreNormalised: 12, rugged: false, risks: [{ name: 'Mutable metadata', level: 'warn' }] } };
    case 'midLiquidity':
      return { ...facts, liquidity: withLiquidity(round(between(random, 10_500, 19_500), 0)) };
    case 'concentrated':
      return { ...facts, holders: { top10Pct: round(between(random, 31, 46), 1), maxSingleHolderPct: round(between(random, 4, 9.5), 1), excludedAccounts: 2 } };
    case 'young': {
      const hours = between(random, 4, 40);
      return {
        ...facts,
        liquidity: withLiquidity(round(between(random, 4_000, 60_000), 0)),
        age: { tokenCreatedAt: iso(at - hours * HOUR_MS), poolCreatedAt: iso(at - Math.max(1, hours - 1) * HOUR_MS) },
      };
    }
    case 'pump': {
      const minutes = between(random, 5, 300);
      return {
        ...facts,
        liquidity: withLiquidity(round(between(random, 1_500, 6_000), 0)),
        holders: { top10Pct: round(between(random, 30, 55), 1), maxSingleHolderPct: round(between(random, 8, 22), 1), excludedAccounts: 1 },
        sellSimulation: { routeFound: true, priceImpactPct: round(between(random, 3, 12)), implicitTaxPct: round(between(random, 0, 4)), testAmountUsd: 100 },
        age: { tokenCreatedAt: iso(at - minutes * 60_000), poolCreatedAt: iso(at - Math.max(1, minutes - 1) * 60_000) },
        creator: { address: null, tokensLaunched: Math.floor(between(random, 4, 30)), tokensDeadOrRugged: Math.floor(between(random, 2, 12)) },
        rugcheck: { scoreNormalised: 38, rugged: false, risks: [{ name: 'Creator history of rugged tokens', level: 'danger' }] },
      };
    }
    case 'partial':
      return { ...facts, holders: null, sellSimulation: null, creator: null, rugcheck: null };
    case 'mintActive':
      return { ...facts, mintAccount: { ...(facts.mintAccount as NonNullable<RiskFacts['mintAccount']>), mintAuthorityActive: true } };
    case 'freezeActive':
      return { ...facts, mintAccount: { ...(facts.mintAccount as NonNullable<RiskFacts['mintAccount']>), freezeAuthorityActive: true } };
    case 'honeypot':
      return { ...facts, sellSimulation: { routeFound: false, priceImpactPct: null, implicitTaxPct: null, testAmountUsd: 100 } };
  }
}

/** Sort tiré pour un token : rug (événement, horizon), mort (horizon) ou survie. */
type Fate =
  | { readonly kind: 'rug'; readonly event: Exclude<OutcomeEvent, 'TOKEN_DEAD'>; readonly fromHorizon: number }
  | { readonly kind: 'dead'; readonly fromHorizon: number }
  | { readonly kind: 'alive' };

function drawFate(profile: SimulationProfile, random: () => number): Fate {
  const risk = PROFILE_RISK[profile];
  const draw = random();
  const fromHorizon = Math.floor(random() * FOLLOW_UP_HORIZONS.length);
  if (draw < risk.rug) {
    const which = random();
    const event = which < 0.45 ? 'LP_REMOVED' : which < 0.85 ? 'PRICE_CRASH_90' : 'MINT_USED';
    return { kind: 'rug', event, fromHorizon };
  }
  if (draw < risk.rug + risk.dead) return { kind: 'dead', fromHorizon };
  return { kind: 'alive' };
}

/** Parts d'observations manquantes, hors fenêtre et inexploitables (cas que l'écran doit compter). */
const MISSING_RATE = 0.04;
const OUT_OF_WINDOW_RATE = 0.03;
const UNKNOWN_RATE = 0.03;

function observe(record: VerdictRecord, fate: Fate, horizonIndex: number, random: () => number): FollowUpObservation | null {
  const horizon = FOLLOW_UP_HORIZONS[horizonIndex] as (typeof FOLLOW_UP_HORIZONS)[number];
  const window = FOLLOW_UP_WINDOWS[horizon];
  const start = Date.parse(record.verdictAt) + window.afterMs;
  const draw = random();
  if (draw < MISSING_RATE) return null;
  const outOfWindow = draw < MISSING_RATE + OUT_OF_WINDOW_RATE;
  const observedAt = iso(outOfWindow ? start + window.toleranceMs + between(random, 1, 6) * HOUR_MS : start + random() * window.toleranceMs * 0.9);
  const base = { recordId: record.id, horizon, observedAt };
  if (draw < MISSING_RATE + OUT_OF_WINDOW_RATE + UNKNOWN_RATE) {
    return { ...base, poolFound: null, lpRemoved: null, priceUsd: null, liquidityUsd: null, volume24hUsd: null, supplyRaw: null };
  }

  const price = record.baseline.priceUsd as number;
  const liquidity = record.baseline.liquidityUsd ?? 20_000;
  const supply = record.baseline.supplyRaw as string;
  if (fate.kind === 'rug' && horizonIndex >= fate.fromHorizon) {
    switch (fate.event) {
      case 'LP_REMOVED':
        return { ...base, poolFound: true, lpRemoved: true, priceUsd: price * 0.04, liquidityUsd: round(liquidity * 0.02), volume24hUsd: 40, supplyRaw: supply };
      case 'PRICE_CRASH_90':
        return { ...base, poolFound: true, lpRemoved: false, priceUsd: price * between(random, 0.01, 0.08), liquidityUsd: round(liquidity * 0.3), volume24hUsd: 900, supplyRaw: supply };
      case 'MINT_USED':
        return { ...base, poolFound: true, lpRemoved: false, priceUsd: price * 0.5, liquidityUsd: round(liquidity * 0.6), volume24hUsd: 4_000, supplyRaw: (BigInt(supply) * 3n).toString() };
    }
  }
  if (fate.kind === 'dead' && horizonIndex >= fate.fromHorizon) {
    return { ...base, poolFound: random() < 0.3 ? false : true, lpRemoved: false, priceUsd: price * 0.4, liquidityUsd: round(between(random, 150, 900)), volume24hUsd: round(between(random, 0, 90)), supplyRaw: supply };
  }
  return {
    ...base,
    poolFound: true,
    lpRemoved: false,
    priceUsd: price * between(random, 0.5, 2.5),
    liquidityUsd: round(liquidity * between(random, 0.75, 1.5)),
    volume24hUsd: round(between(random, 500, 80_000)),
    supplyRaw: supply,
  };
}

export interface SimulatedHistory {
  readonly seed: number;
  readonly simulated: true;
  readonly records: readonly VerdictRecord[];
  readonly observations: readonly FollowUpObservation[];
}

export interface SimulationOptions {
  /** Premier verdict (ISO 8601). Défaut : 2026-09-01T00:00:00.000Z. */
  readonly start?: string;
  /** Écart moyen entre deux verdicts (heures). Défaut : 2. */
  readonly spacingHours?: number;
}

export const MAX_SIMULATION_SIZE = 10_000;

/**
 * Historique simulé de `size` verdicts (moteur de référence) et de leurs observations à 24 h,
 * 72 h et 7 j. Les dix premiers verdicts parcourent tous les profils.
 */
export function simulateHistory(seed: number, size: number, options: SimulationOptions = {}): SimulatedHistory {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Graine invalide (entier 32 bits).');
  if (!Number.isInteger(size) || size < 0 || size > MAX_SIMULATION_SIZE) throw new RangeError('Taille de simulation invalide.');
  const startAt = Date.parse(options.start ?? '2026-09-01T00:00:00.000Z');
  const spacing = options.spacingHours ?? 2;
  if (!Number.isFinite(startAt) || !Number.isFinite(spacing) || spacing <= 0) throw new RangeError('Options de simulation invalides.');

  const random = createPrng(seed);
  const records: VerdictRecord[] = [];
  const observations: FollowUpObservation[] = [];
  for (let index = 0; index < size; index += 1) {
    const profile = index < SIMULATION_PROFILES.length ? (SIMULATION_PROFILES[index] as SimulationProfile) : pickProfile(random);
    const verdictAt = iso(startAt + index * spacing * HOUR_MS + Math.floor(random() * spacing * 0.5 * HOUR_MS));
    const facts = simulateFacts(profile, randomMint(random), verdictAt, random);
    const assessment = evaluateRisk(facts);
    const flaggedChecks: AnalysisCheckId[] = assessment.checks
      .filter((check) => check.status === 'warn' || check.status === 'danger')
      .map((check) => check.id);
    const record: VerdictRecord = {
      id: `sim-${seed}-${index}`,
      mint: facts.mint,
      verdictAt,
      engineVersion: RISK_ENGINE_VERSION,
      verdict: assessment.verdict,
      reasonCodes: [...new Set(assessment.reasons.map((reason) => reason.code))],
      flaggedChecks,
      baseline: {
        priceUsd: 10 ** between(random, -7, 0),
        liquidityUsd: facts.liquidity?.usd ?? null,
        supplyRaw: (BigInt(Math.floor(between(random, 1e8, 1e9))) * 1_000_000n).toString(),
      },
      facts,
    };
    records.push(record);
    const fate = drawFate(profile, random);
    FOLLOW_UP_HORIZONS.forEach((_, horizonIndex) => {
      const observation = observe(record, fate, horizonIndex, random);
      if (observation !== null) observations.push(observation);
    });
  }
  return { seed, simulated: true, records, observations };
}

/** Variantes de démonstration affichées sur l'écran tant que les vraies ne sont pas enregistrées. */
export const DEMO_VARIANTS: readonly EngineVariant[] = [
  { id: 'top10-40', label: 'Concentration top 10 tolérée jusqu’à 40 %', overrides: { top10WarnPct: 40 } },
  { id: 'liquidite-20k', label: 'Liquidité faible sous 20 000 $', overrides: { liquidityLowUsd: 20_000 } },
];
