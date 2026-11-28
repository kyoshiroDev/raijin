import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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

/** Fixture d'une séquence : `<scénario>.step<N>[.<détail>].json` (rejouée à l'étape N et suivantes). */
const STEP_FILE = /^(.+?)\.step(\d{1,3})(?:\.[^/]+)?\.json$/;

function readFixture(file: string): Fixture {
  return JSON.parse(readFileSync(file, 'utf8')) as Fixture;
}

/**
 * Toutes les fixtures d'un dossier (défaut : celles de la lib ; un bundle passe son propre chemin),
 * **hors séquences** (`*.step<N>*.json`, chargées par `loadFixtureSequence`).
 */
export function loadAllFixtures(dir = FIXTURES_DIR): Fixture[] {
  return fixtureFiles(dir)
    .filter((file) => !STEP_FILE.test(basename(file)))
    .map(readFixture);
}

/** Noms des scénarios en séquence disponibles (`watch-lp-removed`, …). */
export function fixtureSequenceNames(dir = FIXTURES_DIR): string[] {
  const names = fixtureFiles(dir).flatMap((file) => {
    const match = STEP_FILE.exec(basename(file));
    return match ? [match[1] as string] : [];
  });
  return [...new Set(names)].sort();
}

/** Fixtures d'un scénario en séquence, par étape (index = N ; étape sans fichier = liste vide). */
export function loadFixtureSequence(scenario: string, dir = FIXTURES_DIR): Fixture[][] {
  const steps: Fixture[][] = [];
  for (const file of fixtureFiles(dir)) {
    const match = STEP_FILE.exec(basename(file));
    if (!match || match[1] !== scenario) continue;
    const step = Number(match[2]);
    for (let index = steps.length; index <= step; index += 1) steps.push([]);
    (steps[step] as Fixture[]).push(readFixture(file));
  }
  if (steps.length === 0) throw new Error(`Scénario de fixtures inconnu : ${scenario}.`);
  return steps;
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

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Adresse base58 déterministe (32 octets de SHA-256 d'un libellé « raijin:fixture:… »). */
export function fixtureAddress(label: string): string {
  const bytes = createHash('sha256').update(`raijin:fixture:${label}`).digest();
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (value > 0n) {
    out = (BASE58[Number(value % 58n)] as string) + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

interface SyntheticTokenAccounts {
  readonly $synthetic: 'tokenAccounts';
  readonly count: number;
  readonly owner: string;
  readonly programId: string;
  readonly mint: string;
  readonly decimals: number;
  readonly seed: string;
}

function isSynthetic(value: unknown): value is SyntheticTokenAccounts {
  return typeof value === 'object' && value !== null && (value as { $synthetic?: unknown }).$synthetic === 'tokenAccounts';
}

/**
 * Corps `{ result: { value: { $synthetic: 'tokenAccounts', count, … } } }` : liste développée en
 * `count` comptes jsonParsed déterministes (wallet hors normes, sans fichier de plusieurs Mo).
 */
function expandSynthetic(body: unknown): unknown {
  const result = (body as { result?: { value?: unknown } } | null)?.result;
  if (!result || !isSynthetic(result.value)) return body;
  const spec = result.value;
  const value = Array.from({ length: Math.min(spec.count, 5_000) }, (_, index) => ({
    pubkey: fixtureAddress(`${spec.seed}:acct:${index}`),
    account: {
      data: {
        parsed: {
          info: {
            isNative: false,
            mint: spec.mint,
            owner: spec.owner,
            state: 'initialized',
            tokenAmount: { amount: String(index + 1), decimals: spec.decimals, uiAmount: (index + 1) / 10 ** spec.decimals, uiAmountString: String((index + 1) / 10 ** spec.decimals) },
          },
          type: 'account',
        },
        program: 'spl-token',
        space: 165,
      },
      executable: false,
      lamports: 2039280,
      owner: spec.programId,
      space: 165,
    },
  }));
  return { ...(body as object), result: { ...result, value } };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `fetch` simulé qui rejoue les fixtures. Une requête sans fixture lève une erreur réseau dont le
 * message **contient l'URL** (comme undici) : sert à vérifier que la lib ne la propage jamais.
 */
export function createFixtureFetch(
  fixtureSource: readonly Fixture[] | (() => readonly Fixture[]) = loadAllFixtures(),
  config: SolanaDataConfig = DEFAULT_SOLANA_DATA_CONFIG,
  overrides: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined,
): FixtureFetch {
  const calls: RecordedCall[] = [];
  const urls: string[] = [];

  const fetchFn: FetchLike = async (url, init) => {
    const fixtures = typeof fixtureSource === 'function' ? fixtureSource() : fixtureSource;
    urls.push(url);
    const override = await overrides(url, init);

    if (url.startsWith(config.heliusRpcBaseUrl) || url.startsWith(config.publicRpcUrl)) {
      const helius = url.startsWith(config.heliusRpcBaseUrl);
      const payload = JSON.parse(String(init?.body)) as { method: string; params: unknown };
      const source = helius ? (payload.method.startsWith('getAsset') ? 'helius_das' : 'helius_rpc') : 'solana_rpc';
      calls.push({ source, route: payload.method });
      if (override) return override;
      const order = helius ? ['helius', 'solana-rpc'] : ['solana-rpc'];
      for (const wanted of order) {
        const match = fixtures.find(
          (fixture) => fixture.source === wanted && fixture.request.rpcMethod === payload.method && sameJson(fixture.request.params, payload.params),
        );
        if (match) return jsonResponse(match.status, expandSynthetic(match.body));
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

export interface FixtureSequence extends FixtureFetch {
  /** Étape courante (0 au départ). */
  readonly step: number;
  /** Nombre d'étapes du scénario. */
  readonly steps: number;
  /** Passe à l'étape suivante (bloquée sur la dernière). */
  advance(): void;
  goTo(step: number): void;
}

/**
 * Rejeu d'un scénario en séquence (t0, t1…) : à l'étape N, une requête est servie par la fixture
 * de l'étape la plus récente ≤ N qui la connaît, sinon par les fixtures de base. Sert à tester les
 * transitions des suivis (LP retirée, mint réactivé, holder vendeur, verdict dégradé), y compris
 * depuis l'API (job déclenché sur fixtures).
 */
export function createFixtureSequence(
  scenario: string,
  options: {
    readonly base?: readonly Fixture[];
    readonly config?: SolanaDataConfig;
    readonly overrides?: Parameters<typeof createFixtureFetch>[2];
    readonly dir?: string;
  } = {},
): FixtureSequence {
  const sequence = loadFixtureSequence(scenario, options.dir);
  const base = options.base ?? loadAllFixtures(options.dir);
  let step = 0;
  const current = () => [...sequence.slice(0, step + 1).reverse().flat(), ...base];
  const fixtureFetch = createFixtureFetch(current, options.config, options.overrides);
  return {
    ...fixtureFetch,
    get step() {
      return step;
    },
    steps: sequence.length,
    advance() {
      step = Math.min(step + 1, sequence.length - 1);
    },
    goTo(target: number) {
      if (!Number.isInteger(target) || target < 0 || target >= sequence.length) throw new RangeError('Étape inconnue.');
      step = target;
    },
  };
}
