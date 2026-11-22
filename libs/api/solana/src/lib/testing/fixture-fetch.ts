import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SOLANA_DATA_CONFIG, type SolanaDataConfig } from '../config';
import type { FetchLike } from '../core/ports';

/*
 * Rejeu des fixtures, exposé par le sous-chemin `@raijin/api-solana/testing` (jamais par l'index
 * principal) : tests de la lib, tests et mode démonstration `ANALYSIS_FIXTURES=1` de l'API.
 * Ne doit jamais être activé en production (choix de configuration de l'hôte).
 */

/** Fixture enregistrée (ARCHITECTURE.md §9.9) : ni URL complète ni en-tête. */
export interface Fixture {
  readonly recordedAt: string;
  readonly source: string;
  readonly synthetic?: boolean;
  readonly note?: string;
  readonly request: {
    readonly method: 'GET' | 'POST';
    readonly path?: string;
    readonly rpcMethod?: string;
    readonly params: unknown;
  };
  readonly status: number;
  readonly body: unknown;
}

export const FIXTURES_DIR = join(__dirname, '..', '..', 'fixtures');

export function fixtureFiles(dir = FIXTURES_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? fixtureFiles(join(dir, entry.name)) : entry.name.endsWith('.json') ? [join(dir, entry.name)] : [],
  );
}

export function loadFixture(source: string, scenario: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, source, `${scenario}.json`), 'utf8')) as Fixture;
}

/** Toutes les fixtures d'un dossier (défaut : celles de la lib ; un bundle passe son propre chemin). */
export function loadAllFixtures(dir = FIXTURES_DIR): Fixture[] {
  return fixtureFiles(dir).map((file) => JSON.parse(readFileSync(file, 'utf8')) as Fixture);
}

/** Paramètres ignorés à la comparaison (montant du devis : dépend du prix au moment de l'enregistrement). */
const IGNORED_QUERY_PARAMS = new Set(['amount', 'slippageBps']);

export interface RecordedCall {
  readonly source: string;
  readonly route: string;
}

export interface FixtureFetch {
  readonly fetch: FetchLike;
  readonly calls: RecordedCall[];
  /** URL complètes reçues (pour vérifier qu'elles ne fuient jamais ailleurs). */
  readonly urls: string[];
}

function jsonResponse(status: number, body: unknown): Response {
  if (body === null || body === undefined) {
    return new Response('', { status, headers: { 'content-type': 'text/plain' } });
  }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `fetch` simulé qui rejoue les fixtures. Une requête sans fixture lève une erreur réseau dont le
 * message **contient l'URL** (comme undici) : sert à vérifier que la lib ne la propage jamais.
 */
export function createFixtureFetch(
  fixtures: readonly Fixture[] = loadAllFixtures(),
  config: SolanaDataConfig = DEFAULT_SOLANA_DATA_CONFIG,
  overrides: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined,
): FixtureFetch {
  const calls: RecordedCall[] = [];
  const urls: string[] = [];

  const fetchFn: FetchLike = async (url, init) => {
    urls.push(url);
    const override = await overrides(url, init);

    if (url.startsWith(config.heliusRpcBaseUrl) || url.startsWith(config.publicRpcUrl)) {
      const helius = url.startsWith(config.heliusRpcBaseUrl);
      const payload = JSON.parse(String(init?.body)) as { method: string; params: unknown };
      const source = helius ? (payload.method === 'getAsset' ? 'helius_das' : 'helius_rpc') : 'solana_rpc';
      calls.push({ source, route: payload.method });
      if (override) return override;
      const order = helius ? ['helius', 'solana-rpc'] : ['solana-rpc'];
      for (const wanted of order) {
        const match = fixtures.find(
          (fixture) => fixture.source === wanted && fixture.request.rpcMethod === payload.method && sameJson(fixture.request.params, payload.params),
        );
        if (match) return jsonResponse(match.status, match.body);
      }
      throw new TypeError(`fetch failed ${url}`);
    }

    const rest: Array<[string, string]> = [
      ['dexscreener', config.dexscreenerBaseUrl],
      ['geckoterminal', config.geckoterminalBaseUrl],
      ['jupiter', config.jupiterBaseUrl],
      ['rugcheck', config.rugcheckBaseUrl],
    ];
    const entry = rest.find(([, base]) => url.startsWith(base));
    if (!entry) throw new TypeError(`fetch failed ${url}`);
    const [source, base] = entry;
    const [path = '', query = ''] = url.slice(base.length).split('?');
    const params = Object.fromEntries(query === '' ? [] : query.split('&').map((pair) => pair.split('=').map(decodeURIComponent)));
    calls.push({ source, route: path });
    if (override) return override;
    const match = fixtures.find((fixture) => {
      if (fixture.source !== source || fixture.request.path !== path) return false;
      const expected = (fixture.request.params ?? {}) as Record<string, string>;
      return Object.entries(expected).every(([key, value]) => IGNORED_QUERY_PARAMS.has(key) || params[key] === value);
    });
    if (!match) throw new TypeError(`fetch failed ${url}`);
    const body = match.body as { oversizeBytes?: number } | null;
    if (body !== null && typeof body === 'object' && typeof body.oversizeBytes === 'number') {
      // Rapport de plusieurs Mo : en-tête de taille seul, le client doit refuser sans lire le corps.
      return new Response('{}', { status: match.status, headers: { 'content-type': 'application/json', 'content-length': String(body.oversizeBytes) } });
    }
    return jsonResponse(match.status, match.body);
  };

  return { fetch: fetchFn, calls, urls };
}
