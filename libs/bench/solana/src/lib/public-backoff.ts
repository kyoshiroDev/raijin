import { SYSTEM_CLOCK, UpstreamError, type Clock, type FetchLike, type SolanaDataConfig } from '@raijin/api-solana';
import type { BenchSharedIpSource } from './config';

/**
 * Recul exponentiel du banc sur les sources publiques partagées avec Raijin (même IP, BENCH.md §9 P6).
 * Au premier 429 d'une source, le banc **cesse de l'appeler** pendant `baseMs` (ou le `Retry-After` s'il est
 * plus long), puis double l'attente à chaque 429 consécutif jusqu'à `maxMs` ; une réponse non-429 remet à zéro.
 * Pendant la pause, l'appel échoue sans requête (`circuit_open` : non rejoué, compté comme refus) et le contrôle
 * concerné est « indisponible ». Raijin, lui, garde sa propre file et ses débits : il reste prioritaire.
 */
export interface PublicBackoffOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly clock?: Clock;
}

export interface SourceBackoffState {
  readonly source: BenchSharedIpSource;
  /** 429 consécutifs. */
  readonly consecutive429: number;
  /** Fin de la pause (ms epoch), `null` si la source est ouverte. */
  readonly pausedUntil: number | null;
}

export const PUBLIC_BACKOFF_BASE_MS = 30_000;
export const PUBLIC_BACKOFF_MAX_MS = 15 * 60_000;

interface Entry {
  consecutive: number;
  pausedUntil: number;
}

export class PublicSourceBackoff {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly clock: Clock;
  private readonly entries = new Map<BenchSharedIpSource, Entry>();

  constructor(options: PublicBackoffOptions = {}) {
    this.baseMs = options.baseMs ?? PUBLIC_BACKOFF_BASE_MS;
    this.maxMs = options.maxMs ?? PUBLIC_BACKOFF_MAX_MS;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    if (!(this.baseMs > 0) || !(this.maxMs >= this.baseMs)) throw new RangeError('Recul invalide.');
  }

  /** Vrai si la source est en pause (aucun appel ne doit partir). */
  isPaused(source: BenchSharedIpSource): boolean {
    const entry = this.entries.get(source);
    return entry !== undefined && entry.pausedUntil > this.clock.now();
  }

  /** Enregistre un 429 ; renvoie la durée de pause appliquée (ms). */
  record429(source: BenchSharedIpSource, retryAfterMs: number | null): number {
    const entry = this.entries.get(source) ?? { consecutive: 0, pausedUntil: 0 };
    entry.consecutive += 1;
    const exponential = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(entry.consecutive - 1, 30));
    const pause = Math.min(this.maxMs, Math.max(exponential, retryAfterMs ?? 0));
    entry.pausedUntil = this.clock.now() + pause;
    this.entries.set(source, entry);
    return pause;
  }

  /** Réponse obtenue sans 429 : remise à zéro. */
  recordOk(source: BenchSharedIpSource): void {
    this.entries.delete(source);
  }

  /** État par source (santé du banc). */
  snapshot(): SourceBackoffState[] {
    const now = this.clock.now();
    return [...this.entries.entries()].map(([source, entry]) => ({
      source,
      consecutive429: entry.consecutive,
      pausedUntil: entry.pausedUntil > now ? entry.pausedUntil : null,
    }));
  }
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return null;
  return Number(raw.trim()) * 1_000;
}

/** Préfixes d'URL (origine + chemin de base) des sources à IP partagée, d'après la configuration résolue. */
export function sharedIpRoutes(config: SolanaDataConfig): ReadonlyArray<readonly [BenchSharedIpSource, string]> {
  return [
    ['solana_rpc', config.publicRpcUrl],
    ['dexscreener', config.dexscreenerBaseUrl],
    ['geckoterminal', config.geckoterminalBaseUrl],
    ['jupiter', config.jupiterBaseUrl],
    ['rugcheck', config.rugcheckBaseUrl],
  ];
}

function matchSource(url: string, routes: ReadonlyArray<readonly [BenchSharedIpSource, string]>): BenchSharedIpSource | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  for (const [source, base] of routes) {
    const prefix = new URL(base);
    if (target.origin !== prefix.origin) continue;
    const path = prefix.pathname.replace(/\/+$/, '');
    if (path === '' || target.pathname === path || target.pathname.startsWith(`${path}/`)) return source;
  }
  return null;
}

/**
 * Enveloppe `fetch` : applique `PublicSourceBackoff` aux sources à IP partagée (les URL Helius, qui portent la
 * clé, ne sont pas concernées et ne sont jamais conservées ni journalisées).
 */
export function withPublicBackoff(fetchFn: FetchLike, config: SolanaDataConfig, backoff: PublicSourceBackoff): FetchLike {
  const routes = sharedIpRoutes(config);
  return async (input, init) => {
    const source = matchSource(input, routes);
    if (source === null) return fetchFn(input, init);
    if (backoff.isPaused(source)) throw new UpstreamError(source, 'circuit_open');
    const response = await fetchFn(input, init);
    if (response.status === 429) backoff.record429(source, retryAfterMs(response));
    else backoff.recordOk(source);
    return response;
  };
}
