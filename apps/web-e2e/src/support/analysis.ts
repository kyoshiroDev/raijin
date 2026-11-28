import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { APP_ORIGIN } from './auth';

/**
 * Parcours d'analyse contre l'API réelle en mode fixtures (`ANALYSIS_FIXTURES=1`, `TRUST_PROXY=1`) :
 * les sources Solana rejouent libs/api/solana/src/fixtures, sans réseau. Chaque test se donne une IP
 * fictive (X-Forwarded-For) pour disposer d'un quota anonyme neuf (3 analyses par jour et par IP).
 */
export const PROD_ORIGIN = process.env['PROD_ORIGIN'] ?? 'http://127.0.0.1:4310';
export const API_ORIGIN = process.env['API_ORIGIN'] ?? 'http://localhost:3100';

/** Mints des fixtures (verdicts obtenus sans clé Helius). */
export const MINTS = {
  /** BONK : Prudence (RugCheck), résultat partiel (3 contrôles indisponibles sans clé Helius). */
  bonk: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  /** Paire BONK sur DexScreener : résolue vers le mint BONK. */
  bonkPair: '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9',
  /** USDC : Prudence (émetteur régulé connu, freeze actif). */
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  pyusd: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  /** Token pump.fun récent (lien pump.fun). */
  pump: '9rA3rJrcFJeQwWaLaHgJLi4LaF6wvRoae9ybwcYApump',
  /** Autorité de mint active : Danger. */
  mintActive: 'BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi',
  /** Autorité de freeze active, aucune route de vente : Danger, résultat complet. */
  honeypot: '3Ss6A75uZG9cSRt4feyhcmJVGT38USeygDfwi1tBGQVa',
  /** Compte inexistant : TOKEN_NOT_FOUND. */
  missing: 'Y3Pg4fGfK1jz4exHgF2duMUhZvjAa1FdBuJYMsyZfWD',
} as const;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Adresse base58 de 32 octets valide, jamais analysée (page publique sans analyse). */
export function randomMint(): string {
  let n = BigInt(`0x${randomBytes(32).toString('hex')}`) | (1n << 255n);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

export function randomIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

/** Donne au contexte du navigateur une IP fictive (quota anonyme neuf) et la renvoie. */
export async function useFreshIp(page: Page): Promise<string> {
  const ip = randomIp();
  await page.context().setExtraHTTPHeaders({ 'X-Forwarded-For': ip });
  return ip;
}

/** Analyse par l'API (CSRF anonyme) avec l'IP donnée ; renvoie le statut et le corps. */
export async function analyzeViaApi(request: APIRequestContext, ip: string, input: string) {
  const headers = { 'X-Forwarded-For': ip };
  const csrfRes = await request.get(`${APP_ORIGIN}/api/v1/auth/csrf`, { headers });
  expect(csrfRes.status(), 'GET /auth/csrf').toBe(200);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await request.post(`${APP_ORIGIN}/api/v1/analyses`, {
    data: { input },
    headers: { ...headers, Origin: APP_ORIGIN, 'X-CSRF-Token': csrfToken },
  });
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/** Consomme le quota anonyme (3 mints distincts) de l'IP du contexte. */
export async function exhaustAnonymousQuota(page: Page, ip: string): Promise<void> {
  for (const mint of [MINTS.bonk, MINTS.usdc, MINTS.honeypot]) {
    const { status, body } = await analyzeViaApi(page.context().request, ip, mint);
    expect(status, `analyse ${mint} : ${JSON.stringify(body)}`).toBe(200);
  }
}

/** Garantit une analyse publiée ≤ 24 h pour la page publique `/t/<mint>`. */
export async function publishAnalysis(request: APIRequestContext, mint: string): Promise<void> {
  const { status, body } = await analyzeViaApi(request, randomIp(), mint);
  expect(status, `publication ${mint} : ${JSON.stringify(body)}`).toBe(200);
}

/** Champ de saisie (getByLabel attrape aussi le bouton « Coller »). */
export const tokenField = (page: Page) => page.getByRole('textbox', { name: 'Adresse ou lien du token' });

/** Bloc du verdict (role=status, nom « Verdict : … »). */
export const verdictStatus = (page: Page) => page.getByRole('status', { name: /^Verdict : / });

/** Attend un résultat d'analyse affiché avec le verdict attendu. */
export async function expectVerdict(page: Page, label: 'Sain' | 'Prudence' | 'Danger', timeout = 20_000): Promise<void> {
  await expect(verdictStatus(page)).toHaveAccessibleName(`Verdict : ${label}`, { timeout });
}
