import { ANALYSIS_CHECK_IDS, type AnalysisCheckId, type RiskReasonCode } from '@raijin/shared-contracts';
import { RISK_ENGINE_VERSION } from './shared-risk-engine';

/**
 * Émetteurs régulés connus : leur autorité de freeze (et de mint) est une obligation
 * réglementaire documentée, pas un piège. Signalée en « attention », jamais en « danger ».
 */
export const KNOWN_ISSUER_MINTS: Readonly<Record<string, string>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC (Circle)',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT (Tether)',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'PYUSD (Paxos)',
};

/**
 * Seuils et pondérations du moteur. Tout est en configuration pour que le banc évalue des
 * variantes (PROMPT.md §4.8) : `createRiskEngine({ ...DEFAULT_RISK_ENGINE_CONFIG, top10WarnPct: 40 })`.
 * Justification de chaque valeur : docs/SCORING.md.
 */
export interface RiskEngineConfig {
  /** Version publiée dans la sortie (`1.0.0`, ou `1.0.0-variante.a` pour une variante du banc). */
  readonly version: string;
  /** Mints d'émetteurs régulés (freeze / mint actif → attention au lieu de danger). */
  readonly knownIssuerMints: readonly string[];
  /** Liquidité totale en dessous de laquelle on signale « liquidité faible » (USD). */
  readonly liquidityLowUsd: number;
  /** Part minimale de LP brûlée ou verrouillée attendue (%). En dessous : attention. */
  readonly lpBurnedOrLockedMinPct: number;
  /**
   * Âge du pool (jours) au-delà duquel le critère « LP brûlée ou verrouillée » n'est plus évalué
   * (pools concentrés sans jeton LP, liquidité qui a tenu dans la durée). Voir docs/SCORING.md, L3.
   */
  readonly lpLockCheckMaxPoolAgeDays: number;
  /** Part du top 10 (hors LP et programmes) au-delà de laquelle on signale (%). */
  readonly top10WarnPct: number;
  /** Part d'un seul wallet au-delà de laquelle on signale (%) (PROMPT.md §4.1 : 10 %). */
  readonly singleHolderWarnPct: number;
  /** Taxe implicite de vente au-delà de laquelle on signale (%). */
  readonly sellTaxWarnPct: number;
  /** Taxe implicite à partir de laquelle la revente est assimilée à un honeypot (critique, %). */
  readonly sellTaxCriticalPct: number;
  /** Impact prix du devis de test au-delà duquel on signale (%). */
  readonly priceImpactWarnPct: number;
  /** Frais de transfert Token-2022 au-delà desquels on signale (points de base). */
  readonly transferFeeWarnBps: number;
  /** Frais de transfert Token-2022 assimilés à un honeypot (critique, points de base). */
  readonly transferFeeCriticalBps: number;
  /** Token plus jeune que ce seuil : attention (heures). */
  readonly tokenVeryNewHours: number;
  /** Pool plus jeune que ce seuil : attention (heures). */
  readonly poolVeryNewHours: number;
  /** Nombre de tokens morts ou rug du créateur à partir duquel on signale. */
  readonly creatorDeadTokensWarn: number;
  /** Nombre de contrôles indisponibles à partir duquel le verdict ne peut pas être Sain. */
  readonly unavailableChecksBlockSafe: number;
  /** Somme des poids des signaux modérés à partir de laquelle le verdict est Prudence. */
  readonly cautionScoreThreshold: number;
  /** Poids des signaux modérés (défaut 1). Les raisons critiques ne sont pas pondérées. */
  readonly reasonWeights: Readonly<Partial<Record<RiskReasonCode, number>>>;
  /**
   * Contrôles **non demandés** par le profil de collecte (règle D3, docs/SCORING.md) : sans donnée,
   * ils sont « non évalués » et ne comptent pas pour D2. Vide par défaut (analyse complète). Le scan
   * de wallet utilise `LIGHT_PROFILE_NOT_EVALUATED`. Les autorités mint / freeze (D1) sont refusées.
   */
  readonly notEvaluated: readonly AnalysisCheckId[];
}

/**
 * Contrôles non demandés par le profil `light` (scan de wallet, ARCHITECTURE.md §12.4) : devis de
 * vente Jupiter, historique du créateur, RugCheck. Les extensions Token-2022 qui bloquent la revente
 * (non transférable, frais) restent évaluées : elles viennent du compte de mint.
 */
export const LIGHT_PROFILE_NOT_EVALUATED: readonly AnalysisCheckId[] = ['sell_simulation', 'creator_history', 'rugcheck'];

/** Contrôles qui ne peuvent jamais être « non évalués » (règle D1 : verdict impossible sans eux). */
const ALWAYS_EVALUATED: ReadonlySet<AnalysisCheckId> = new Set(['mint_authority', 'freeze_authority']);

export const DEFAULT_RISK_ENGINE_CONFIG: RiskEngineConfig = {
  version: RISK_ENGINE_VERSION,
  knownIssuerMints: Object.keys(KNOWN_ISSUER_MINTS),
  liquidityLowUsd: 10_000,
  lpBurnedOrLockedMinPct: 50,
  lpLockCheckMaxPoolAgeDays: 30,
  top10WarnPct: 30,
  singleHolderWarnPct: 10,
  sellTaxWarnPct: 10,
  sellTaxCriticalPct: 50,
  priceImpactWarnPct: 5,
  transferFeeWarnBps: 0,
  transferFeeCriticalBps: 5_000,
  tokenVeryNewHours: 48,
  poolVeryNewHours: 24,
  creatorDeadTokensWarn: 2,
  unavailableChecksBlockSafe: 3,
  cautionScoreThreshold: 1,
  reasonWeights: {
    METADATA_MUTABLE: 0.5,
    RUGCHECK_WARN: 0.25,
    FREEZE_AUTHORITY_KNOWN_ISSUER: 0.5,
  },
  notEvaluated: [],
};

/** Fusionne une configuration partielle avec les valeurs par défaut et la valide. */
export function resolveRiskEngineConfig(partial: Partial<RiskEngineConfig> = {}): RiskEngineConfig {
  const config: RiskEngineConfig = {
    ...DEFAULT_RISK_ENGINE_CONFIG,
    ...partial,
    reasonWeights: { ...DEFAULT_RISK_ENGINE_CONFIG.reasonWeights, ...partial.reasonWeights },
  };
  for (const id of config.notEvaluated) {
    if (!(ANALYSIS_CHECK_IDS as readonly string[]).includes(id) || ALWAYS_EVALUATED.has(id)) {
      throw new RangeError(`Contrôle non évaluable invalide : ${String(id)}.`);
    }
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(config.version)) {
    throw new RangeError('Version du moteur invalide (semver attendu).');
  }
  const numeric: Array<[string, number]> = [
    ['liquidityLowUsd', config.liquidityLowUsd],
    ['lpBurnedOrLockedMinPct', config.lpBurnedOrLockedMinPct],
    ['lpLockCheckMaxPoolAgeDays', config.lpLockCheckMaxPoolAgeDays],
    ['top10WarnPct', config.top10WarnPct],
    ['singleHolderWarnPct', config.singleHolderWarnPct],
    ['sellTaxWarnPct', config.sellTaxWarnPct],
    ['sellTaxCriticalPct', config.sellTaxCriticalPct],
    ['priceImpactWarnPct', config.priceImpactWarnPct],
    ['transferFeeWarnBps', config.transferFeeWarnBps],
    ['transferFeeCriticalBps', config.transferFeeCriticalBps],
    ['tokenVeryNewHours', config.tokenVeryNewHours],
    ['poolVeryNewHours', config.poolVeryNewHours],
    ['creatorDeadTokensWarn', config.creatorDeadTokensWarn],
    ['unavailableChecksBlockSafe', config.unavailableChecksBlockSafe],
    ['cautionScoreThreshold', config.cautionScoreThreshold],
    ...Object.entries(config.reasonWeights).map(([key, value]): [string, number] => [key, value ?? 0]),
  ];
  for (const [key, value] of numeric) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Seuil invalide : ${key}.`);
    }
  }
  return config;
}
