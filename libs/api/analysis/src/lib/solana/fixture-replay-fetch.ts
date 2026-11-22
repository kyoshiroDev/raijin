import type { FetchLike, SolanaDataConfig } from '@raijin/api-solana';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Rejeu des fixtures enregistrées de `@raijin/api-solana` (`src/fixtures/<source>/<scénario>.json`,
 * ni URL ni en-tête) pour `ANALYSIS_FIXTURES=1` : tests e2e et démonstration sans réseau ni clé.
 * Même règle d'appariement que le `fetch` de test de la lib : source + méthode RPC + paramètres, ou
 * source + chemin + paramètres de requête (montant du devis ignoré). Requête inconnue : erreur
 * réseau (la source passe « indisponible »). Jamais actif en production (configuration).
 */
interface Fixture {
  readonly source: string;
  readonly request: { readonly path?: string; readonly rpcMethod?: string; readonly params: unknown };
  readonly status: number;
  readonly body: unknown;
}

const IGNORED_QUERY_PARAMS = new Set(['amount', 'slippageBps']);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.json') ? [join(dir, entry.name)] : [],
  );
}

export function loadFixtures(dir: string): Fixture[] {
  return files(dir).map((file) => JSON.parse(readFileSync(file, 'utf8')) as Fixture);
}

function respond(status: number, body: unknown): Response {
  if (body === null || body === undefined) return new Response('', { status, headers: { 'content-type': 'text/plain' } });
  const oversize = (body as { oversizeBytes?: unknown }).oversizeBytes;
  if (typeof oversize === 'number') {
    return new Response('{}', { status, headers: { 'content-type': 'application/json', 'content-length': String(oversize) } });
  }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function createFixtureReplayFetch(fixtures: readonly Fixture[], config: SolanaDataConfig): FetchLike {
  const unknown = () => Promise.reject(new TypeError('fixture absente'));
  return async (url, init) => {
    if (url.startsWith(config.heliusRpcBaseUrl) || url.startsWith(config.publicRpcUrl)) {
      const helius = url.startsWith(config.heliusRpcBaseUrl);
      const payload = JSON.parse(String(init?.body)) as { method: string; params: unknown };
      for (const wanted of helius ? ['helius', 'solana-rpc'] : ['solana-rpc']) {
        const match = fixtures.find(
          (f) => f.source === wanted && f.request.rpcMethod === payload.method && JSON.stringify(f.request.params) === JSON.stringify(payload.params),
        );
        if (match) return respond(match.status, match.body);
      }
      return unknown();
    }
    const rest: Array<[string, string]> = [
      ['dexscreener', config.dexscreenerBaseUrl],
      ['geckoterminal', config.geckoterminalBaseUrl],
      ['jupiter', config.jupiterBaseUrl],
      ['rugcheck', config.rugcheckBaseUrl],
    ];
    const entry = rest.find(([, base]) => url.startsWith(base));
    if (!entry) return unknown();
    const [source, base] = entry;
    const [path = '', query = ''] = url.slice(base.length).split('?');
    const params = Object.fromEntries(query === '' ? [] : query.split('&').map((pair) => pair.split('=').map(decodeURIComponent)));
    const match = fixtures.find((f) => {
      if (f.source !== source || f.request.path !== path) return false;
      const expected = (f.request.params ?? {}) as Record<string, string>;
      return Object.entries(expected).every(([key, value]) => IGNORED_QUERY_PARAMS.has(key) || params[key] === value);
    });
    return match ? respond(match.status, match.body) : unknown();
  };
}
