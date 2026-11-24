// Port Node (bench-engine) : client HTTP sortant commun du code porté (même garde-fous que `requestJson` de
// libs/api/solana). Tous les appels externes de bench-engine (getJson d'enrich-clients, getGecko de gecko-history,
// source Helius de wallet-collect-helius) passent par `safeRequest` :
//   - https uniquement, hôte dans la liste fournie par l'appelant (ceux réellement utilisés), ni identifiants ni port ;
//   - redirections refusées (`redirect: 'error'` côté fetch, et toute réponse 3xx / opaqueredirect est rejetée
//     au cas où un `fetch` injecté ne respecterait pas l'option) ;
//   - délai obligatoire (AbortSignal.timeout), combiné au signal d'arrêt du run ;
//   - corps lu en flux et coupé au-delà de `maxBytes` (2 Mo par défaut ; Content-Length vérifié d'abord) ;
//   - ne journalise rien et ne jette jamais : les messages d'erreur sont expurgés des paramètres de requête
//     (une erreur réseau peut embarquer l'URL, donc `?api-key=` de Helius).
import { runtimeFetch } from './runtime-fetch';

export type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Taille maximale par défaut d'un corps de réponse (octets). */
export const DEFAULT_MAX_BODY_BYTES = 2_000_000;
/** Délai maximal accepté, quel que soit l'appelant. */
export const HARD_MAX_TIMEOUT_MS = 30_000;

export interface SafeRequestOptions {
  /** Hôtes autorisés (comparaison exacte du hostname). */
  hosts: ReadonlySet<string>;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Délai de la requête et de la lecture du corps (plafonné à HARD_MAX_TIMEOUT_MS). */
  timeoutMs: number;
  /** Taille maximale du corps en octets (défaut DEFAULT_MAX_BODY_BYTES). */
  maxBytes?: number;
  /** Arrêt du run : signal déjà abandonné = aucune requête ; en cours = annulée. */
  signal?: AbortSignal;
  /** Reçoit le statut HTTP dès les en-têtes (avant lecture du corps). */
  onStatus?: (status: number) => void;
  /** Injectable (tests) ; défaut : le fetch du processus (runtimeFetch). */
  fetchFn?: HttpFetch;
}

export type SafeRefusal = 'url' | 'host' | 'aborted' | 'redirect' | 'too_large';

export type SafeResponse =
  | { kind: 'ok'; status: number; text: string }
  | { kind: 'http'; status: number }
  | { kind: 'refused'; reason: SafeRefusal; status?: number }
  | { kind: 'error'; name: string; message: string };

/** Retire les valeurs des paramètres de requête et les identifiants d'URL d'un message (jamais de clé en journal). */
export function redactUrls(text: string): string {
  return text
    .replace(/(https?:\/\/)[^\s/@]*@/gi, '$1')
    .replace(/([?&][A-Za-z0-9_.-]+=)[^&\s)"'#]*/g, '$1[redacted]');
}

/** URL acceptable pour un appel sortant (https, hôte autorisé, sans identifiants ni port), sinon null. */
export function checkUrl(url: string, hosts: ReadonlySet<string>): { url: URL } | { refused: 'url' | 'host' } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { refused: 'url' };
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return { refused: 'url' };
  if (!hosts.has(u.hostname)) return { refused: 'host' };
  return { url: u };
}

class BodyTooLarge extends Error {
  constructor() {
    super('response body too large');
    this.name = 'BodyTooLarge';
  }
}

/** Lit le corps en flux, en s'arrêtant (et en annulant le flux) dès que `maxBytes` est dépassé. */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new BodyTooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Appel sortant protégé. Ne jette jamais ; ne journalise rien. */
export async function safeRequest(url: string, opts: SafeRequestOptions): Promise<SafeResponse> {
  const checked = checkUrl(url, opts.hosts);
  if ('refused' in checked) return { kind: 'refused', reason: checked.refused };
  if (opts.signal?.aborted) return { kind: 'refused', reason: 'aborted' };
  const timeoutMs = Math.max(1, Math.min(opts.timeoutMs, HARD_MAX_TIMEOUT_MS));
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const init: RequestInit = { headers: opts.headers, redirect: 'error', signal };
  if (opts.method && opts.method !== 'GET') init.method = opts.method;
  if (opts.body !== undefined) init.body = opts.body;
  try {
    const res = await (opts.fetchFn ?? runtimeFetch())(checked.url.toString(), init);
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      opts.onStatus?.(res.status);
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'refused', reason: 'redirect', status: res.status };
    }
    opts.onStatus?.(res.status);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'http', status: res.status };
    }
    const text = await readBodyCapped(res, opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES);
    return { kind: 'ok', status: res.status, text };
  } catch (e) {
    if (e instanceof BodyTooLarge) return { kind: 'refused', reason: 'too_large' };
    const name = e instanceof Error ? e.name : 'Error';
    const message = e instanceof Error ? e.message : String(e);
    return { kind: 'error', name, message: redactUrls(message).slice(0, 500) };
  }
}
