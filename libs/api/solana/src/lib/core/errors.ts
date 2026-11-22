/** File de débit / client concerné (une par fournisseur, Helius RPC et DAS séparés : budgets distincts). */
export const UPSTREAM_IDS = [
  'helius_rpc',
  'helius_das',
  'solana_rpc',
  'dexscreener',
  'geckoterminal',
  'jupiter',
  'rugcheck',
] as const;
export type UpstreamId = (typeof UPSTREAM_IDS)[number];

export type UpstreamErrorKind =
  | 'timeout'
  | 'network'
  | 'aborted'
  | 'rate_limited'
  | 'http_error'
  | 'rpc_error'
  | 'invalid_response'
  | 'too_large'
  | 'circuit_open'
  | 'queue_full'
  | 'budget_exhausted'
  | 'not_configured';

const RETRYABLE: ReadonlySet<UpstreamErrorKind> = new Set(['timeout', 'network', 'rate_limited']);

/**
 * Erreur d'un fournisseur externe. **Jamais de `cause`** : les erreurs `fetch` (undici) peuvent
 * contenir l'URL appelée, donc la clé Helius. Le message ne contient que la source et le type.
 */
export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';

  constructor(
    readonly source: UpstreamId,
    readonly kind: UpstreamErrorKind,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`Source ${source} indisponible (${kind}${status === null ? '' : ` ${status}`}).`);
  }

  /** Réseau, délai, 429 et 5xx sont rejoués ; le reste (4xx, réponse invalide…) ne l'est pas. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind) || (this.kind === 'http_error' && this.status !== null && this.status >= 500);
  }

  /**
   * Compte comme un échec pour le disjoncteur (panne du fournisseur, pas une donnée absente).
   * `too_large` n'en est pas un : c'est une propriété du compte demandé (plusieurs Mo), le
   * fournisseur répond normalement (mineur m1 de la phase 3).
   */
  get countsAsFailure(): boolean {
    return this.retryable || this.kind === 'invalid_response';
  }
}

/** Le mint n'existe pas ou n'est pas un compte de mint SPL / Token-2022 (`TOKEN_NOT_FOUND`). */
export class TokenNotFoundError extends Error {
  override readonly name = 'TokenNotFoundError';
  readonly code = 'TOKEN_NOT_FOUND' as const;

  constructor() {
    super('Token introuvable.');
  }
}

/**
 * Le compte existe mais ne peut pas être analysé (`TOKEN_UNANALYZABLE`, 422) : réponse de plus de
 * `maxResponseBytes` (2 Mo) pour un compte demandé comme mint. Sans lire le compte, on ne peut pas
 * savoir à coût nul s'il s'agit d'un mint Token-2022 aux extensions volumineuses ou d'un autre
 * compte (file d'événements, carnet d'ordres) : les deux cas donnent cette erreur (le message
 * « ce compte existe, mais Raijin ne sait pas l'analyser » est exact dans les deux cas).
 */
export class TokenUnanalyzableError extends Error {
  override readonly name = 'TokenUnanalyzableError';
  readonly code = 'TOKEN_UNANALYZABLE' as const;

  constructor() {
    super('Compte non analysable.');
  }
}

/** Convertit toute erreur inattendue en `UpstreamError` sans conserver l'original. */
export function toUpstreamError(source: UpstreamId, error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error;
  return new UpstreamError(source, 'network');
}
