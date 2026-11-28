import { DOCUMENT, Injectable, InjectionToken, inject } from '@angular/core';
import {
  BENCH_API_PREFIX,
  BENCH_CSRF_HEADER,
  BENCH_ERROR_CODES,
  BENCH_ROUTES,
  benchCookieNames,
  type BenchErrorCode,
  type BenchRoute,
} from '@raijin/bench-contracts';

/**
 * Client HTTP du banc (`/api` de `apps/raijin-banc-de-test-api`, même origine derrière Traefik).
 * - Session : cookie httpOnly `rjb_session` posé par l'API, jamais lu par le front (`credentials: 'same-origin'`).
 * - CSRF double-submit : chaque écriture renvoie le cookie lisible `rjb_csrf` dans `X-CSRF-Token` ; un 403
 *   `AUTH_CSRF_INVALID` relit la session (l'API repose alors un jeton) puis rejoue la requête une seule fois.
 * - 401 : la session est expirée ou appartient à une autre application → `onUnauthorized` (retour à la connexion).
 * Aucune clé, aucun secret côté navigateur : le front ne connaît que des chemins relatifs.
 */

/** Statuts HTTP sans corps d'erreur exploitable : 0 = réseau injoignable. */
export class BenchApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: BenchErrorCode | null,
    message: string,
  ) {
    super(message);
    this.name = 'BenchApiError';
  }
}

export function isBenchApiError(error: unknown, status?: number): error is BenchApiError {
  return error instanceof BenchApiError && (status === undefined || error.status === status);
}

/** Route absente côté serveur (module pas encore déployé) ou ressource inexistante. */
export function isNotFound(error: unknown): boolean {
  return isBenchApiError(error, 404);
}

export type BenchQueryValue = string | number | boolean | null | undefined | readonly string[];
export type BenchQuery = Readonly<Record<string, BenchQueryValue>>;

export interface BenchRequestOptions {
  /** Paramètres de chemin (`tokens/:mint` → `{ mint }`), encodés. */
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: BenchQuery;
  readonly signal?: AbortSignal;
  /** Appel d'authentification (connexion, session, déconnexion) : un 401 ne déclenche pas `onUnauthorized`. */
  readonly anonymous?: boolean;
}

export type BenchFetch = (input: string, init: RequestInit) => Promise<Response>;

/** `fetch` du navigateur ; remplacé dans les tests. */
export const BENCH_FETCH = new InjectionToken<BenchFetch>('BENCH_FETCH', {
  providedIn: 'root',
  factory: () => (input, init) => globalThis.fetch(input, init),
});

/** Lecture de `document.cookie` ; remplacée dans les tests. */
export const BENCH_COOKIES = new InjectionToken<() => string>('BENCH_COOKIES', {
  providedIn: 'root',
  factory: () => {
    const doc = inject(DOCUMENT);
    return () => doc.cookie ?? '';
  },
});

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const CSRF_COOKIE_NAMES = [benchCookieNames(true).csrf, benchCookieNames(false).csrf];
const ERROR_CODES: ReadonlySet<string> = new Set(BENCH_ERROR_CODES);
const GENERIC_ERROR = 'Le banc ne répond pas. Réessaie dans un instant.';

/** Valeur du cookie CSRF du banc (`__Host-rjb_csrf` en HTTPS, `rjb_csrf` en local), ou null. */
export function readCsrfCookie(cookieHeader: string): string | null {
  const jar = new Map<string, string>();
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!jar.has(name)) jar.set(name, part.slice(eq + 1).trim());
  }
  for (const name of CSRF_COOKIE_NAMES) {
    const value = jar.get(name);
    if (value && value.length <= 512) {
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** `tokens/:mint` + `{ mint }` → `tokens/<mint encodé>` ; un paramètre manquant est une erreur de programmation. */
export function benchPath(route: string, params: Readonly<Record<string, string>> = {}): string {
  return route.replace(/:([a-z_]+)/gi, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value.length === 0) throw new Error(`Paramètre de route manquant : ${name}`);
    return encodeURIComponent(value);
  });
}

/** Chaîne de requête : `undefined` et `null` omis, listes jointes par des virgules (`?mints=a,b`). */
export function benchQueryString(query: BenchQuery = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : '';
}

export function benchUrl(route: string, options: Pick<BenchRequestOptions, 'params' | 'query'> = {}): string {
  return `${BENCH_API_PREFIX}/${benchPath(route, options.params)}${benchQueryString(options.query)}`;
}

async function errorOf(response: Response): Promise<BenchApiError> {
  let code: BenchErrorCode | null = null;
  let message = GENERIC_ERROR;
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const raw = body as { code?: unknown; message?: unknown };
      if (typeof raw.code === 'string' && ERROR_CODES.has(raw.code)) code = raw.code as BenchErrorCode;
      if (typeof raw.message === 'string' && raw.message.length > 0 && raw.message.length <= 300) message = raw.message;
    }
  } catch {
    // Corps absent ou non JSON (page d'erreur Traefik) : message générique.
  }
  return new BenchApiError(response.status, code, message);
}

@Injectable({ providedIn: 'root' })
export class BenchApi {
  private readonly fetchFn = inject(BENCH_FETCH);
  private readonly cookies = inject(BENCH_COOKIES);
  private unauthorized: (() => void) | null = null;
  private csrfRefresh: Promise<void> | null = null;

  /** Appelé à chaque 401 d'une route protégée (AuthStore : oubli de la session et retour à /login). */
  onUnauthorized(handler: () => void): void {
    this.unauthorized = handler;
  }

  get<T = unknown>(route: BenchRoute, options: BenchRequestOptions = {}): Promise<T> {
    return this.request<T>('GET', route, undefined, options);
  }

  post<T = unknown>(route: BenchRoute, body?: unknown, options: BenchRequestOptions = {}): Promise<T> {
    return this.request<T>('POST', route, body, options);
  }

  put<T = unknown>(route: BenchRoute, body?: unknown, options: BenchRequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', route, body, options);
  }

  delete<T = unknown>(route: BenchRoute, body?: unknown, options: BenchRequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', route, body, options);
  }

  private async request<T>(method: string, route: BenchRoute, body: unknown, options: BenchRequestOptions, retried = false): Promise<T> {
    const response = await this.send(method, route, body, options);
    if (response.ok) return (await this.bodyOf(response)) as T;
    const error = await errorOf(response);
    if (error.status === 401) {
      if (!options.anonymous) this.unauthorized?.();
      throw error;
    }
    if (error.status === 403 && error.code === 'AUTH_CSRF_INVALID' && !retried && !SAFE_METHODS.has(method) && !options.anonymous) {
      await this.refreshCsrf();
      return this.request<T>(method, route, body, options, true);
    }
    throw error;
  }

  private async send(method: string, route: BenchRoute, body: unknown, options: BenchRequestOptions): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!SAFE_METHODS.has(method)) {
      const csrf = readCsrfCookie(this.cookies());
      if (csrf !== null) headers[BENCH_CSRF_HEADER] = csrf;
    }
    try {
      return await this.fetchFn(benchUrl(route, options), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: options.signal,
      });
    } catch (error) {
      // Annulation demandée par l'appelant : propagée telle quelle (resource() l'ignore).
      if (options.signal?.aborted) throw error;
      throw new BenchApiError(0, null, GENERIC_ERROR);
    }
  }

  private async bodyOf(response: Response): Promise<unknown> {
    if (response.status === 204) return null;
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BenchApiError(response.status, null, GENERIC_ERROR);
    }
  }

  /** `GET auth/session` repose un jeton CSRF valide ; un 401 ici signifie une session perdue. Mutualisé. */
  private refreshCsrf(): Promise<void> {
    this.csrfRefresh ??= this.request<unknown>('GET', BENCH_ROUTES.authSession, undefined, {})
      .then(() => undefined)
      .finally(() => {
        this.csrfRefresh = null;
      });
    return this.csrfRefresh;
  }
}

/** `{ items, truncated }` des listes de l'API → tableau (vide si la forme est inattendue). */
export function itemsOf(body: unknown): unknown[] {
  if (typeof body !== 'object' || body === null) return [];
  const items = (body as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

/** Drapeau `truncated` des listes de l'API. */
export function truncatedOf(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { truncated?: unknown }).truncated === true;
}
