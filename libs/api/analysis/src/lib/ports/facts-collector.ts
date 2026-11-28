import type { AnalysisCheckId, DataSourceId, DataSourceRef, RiskFacts, TokenProgram } from '@raijin/shared-contracts';

/** Profil de collecte : `full` (analyse de token) ou `light` (scan de wallet, phase 5). */
export type CollectorProfile = 'full' | 'light';

/** Options de collecte : profil et voie de crédits Helius (`watch` pour les passes de suivi). */
export interface CollectorOptions {
  readonly profile: CollectorProfile;
  readonly lane?: 'interactive' | 'watch';
}

/** Statut d'une source pour une collecte (persisté dans `TokenAnalysis.sources`). */
export interface SourceStatus {
  readonly source: DataSourceId;
  readonly status: 'ok' | 'error' | 'skipped';
  readonly latencyMs: number | null;
  /** Type d'erreur (`timeout`, `rate_limited`…), jamais de message ni d'URL. */
  readonly errorKind?: string | null;
}

/**
 * Métadonnées brutes du token telles que collectées : **non fiables** (choisies par le créateur).
 * Nettoyées et bornées par `tokenMetadataSchema` avant tout usage ; aucune image.
 */
export interface CollectedTokenInfo {
  readonly name: string | null;
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly tokenProgram: TokenProgram | null;
}

/** Résultat d'une collecte : faits normalisés pour le moteur + statut par source. */
export interface CollectedFacts {
  readonly facts: RiskFacts;
  readonly token: CollectedTokenInfo | null;
  readonly sources: readonly SourceStatus[];
  /** Sources citées par contrôle (liens publics déjà validés par la collecte) ; à défaut, gabarits de l'API. */
  readonly checkSources?: Readonly<Record<AnalysisCheckId, readonly DataSourceRef[]>>;
  /** Groupe de faits attendu manquant selon la collecte (résultat partiel). */
  readonly degraded?: boolean;
}

/**
 * Port de collecte des faits on-chain et de marché (implémenté par `@raijin/api-solana`, ou par
 * les fixtures en test). L'API d'analyse ne connaît que ce port : aucun appel réseau direct.
 */
export abstract class FactsCollector {
  /** Clé Helius utilisée (cache 60 s) ; `null` : inconnu, la configuration de l'API décide. */
  get heliusConfigured(): boolean | null {
    return null;
  }

  /**
   * Collecte les faits d'un mint. `null` : l'adresse n'est pas un mint SPL / Token-2022 existant.
   * Une source en panne donne un groupe de faits à `null` (contrôle `unavailable`) ; une panne
   * totale lève `UpstreamUnavailableError`.
   */
  abstract collectFacts(mint: string, options: CollectorOptions): Promise<CollectedFacts | null>;

  /**
   * Résout une adresse de paire (lien DexScreener, Birdeye) vers le mint du token de base.
   * `null` : l'adresse n'est pas une paire connue (on la traite alors comme un mint).
   */
  abstract resolveMint(address: string): Promise<string | null>;
}

/** Toutes les sources indispensables sont indisponibles : 503 `UPSTREAM_UNAVAILABLE` (quota remboursé). */
export class UpstreamUnavailableError extends Error {
  constructor() {
    super('Sources de données indisponibles');
    this.name = 'UpstreamUnavailableError';
  }
}

/**
 * Le compte existe mais n'est pas analysable (format ou taille hors normes, ex. compte > 2 Mo) :
 * 422 `TOKEN_UNANALYZABLE`, cache négatif long (aucune nouvelle collecte coûteuse).
 */
export class TokenUnanalyzableError extends Error {
  readonly code = 'TOKEN_UNANALYZABLE' as const;

  constructor() {
    super('Token non analysable');
    this.name = 'TokenUnanalyzableError';
  }
}

/** Erreur « non analysable » de `@raijin/api-solana` ou du port (reconnue par son code stable). */
export function isTokenUnanalyzable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'TOKEN_UNANALYZABLE';
}

/**
 * Collecteur de repli tant qu'aucune source réelle n'est branchée : toute analyse répond
 * `UPSTREAM_UNAVAILABLE` (jamais de verdict inventé).
 */
export class UnavailableFactsCollector extends FactsCollector {
  async collectFacts(): Promise<CollectedFacts | null> {
    throw new UpstreamUnavailableError();
  }

  async resolveMint(): Promise<string | null> {
    return null;
  }
}

/** Horloge injectable (tests déterministes). */
export abstract class AnalysisClock {
  abstract now(): Date;
}

export class SystemClock extends AnalysisClock {
  now(): Date {
    return new Date();
  }
}
