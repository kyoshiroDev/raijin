import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Constantes et outils partagés de l'e2e du banc. Tout est local : API du banc sur API_PORT (3310), front de
 * production servi sur FRONT_PORT (4320), base raijin_bench_dev (ou raijin_bench_e2e en CI). Aucun secret réel :
 * mot de passe, e-mail et clés sont des valeurs de test, le compte est créé puis supprimé à chaque passage.
 */
export const API_PORT = Number(process.env['BENCH_E2E_API_PORT'] ?? 3310);
export const FRONT_PORT = Number(process.env['BENCH_E2E_FRONT_PORT'] ?? 4320);
export const FRONT_ORIGIN = `http://localhost:${FRONT_PORT}`;
export const API_ORIGIN = `http://localhost:${API_PORT}`;
export const OWNER_EMAIL = 'e2e-proprietaire@banc.invalid';
export const OWNER_PASSWORD = 'phrase de passe du banc e2e 2026';
/** Base de test : jamais `raijin_bench` (production) ni la base de Raijin. */
export const BENCH_E2E_DATABASE_URL =
  process.env['BENCH_E2E_DATABASE_URL'] ?? 'postgresql://raijin:changeme-factice@localhost:5433/raijin_bench_dev?schema=public';

export const E2E_DIR = join(__dirname, '..', '..', '..', '..', 'dist', '.playwright', 'apps', 'raijin-banc-de-test-e2e');
export const OWNER_STATE_FILE = join(E2E_DIR, 'owner.json');
export const STORAGE_STATE_FILE = join(E2E_DIR, 'session.json');
export const SCREENSHOT_DIR = join(__dirname, '..', '..', '..', '..', 'docs', 'screenshots', 'phase-8bis');

/**
 * Jetons de fixture, supprimés au teardown : adresses base58 de 32 octets (sha256 de « raijin-banc-e2e-fixture-alpha »,
 * « …-beta », « raijin-banc-e2e-pair-alpha », « …-beta »), valides pour `mintAddressSchema` et la contrainte SQL.
 */
export const FIXTURE_TOKENS = [
  { mint: '4BgzRXq4XLbYpTmXWFrwYrVuXinRmr8QJtpdAPiaJczf', pair: 'AZxcaxyXDfGdv1HaAnKRKDtUgh7R3TvPTkSGp7WVVa8e', symbol: 'FIXA', name: 'Fixture Alpha' },
  { mint: 'FVjGnXptAERNJ7igwvLaubLYFHTgK44z7z1Ghtusb3SZ', pair: 'E3UpH8rzAhJ5PnENduq6688jADgmwJyStd2WRHfMn1F2', symbol: 'FIXB', name: 'Fixture Beta' },
] as const;
/** Marqueur des lignes `public.scan_runs` de fixture (`tokens_seen`). */
export const FIXTURE_SCAN_MARKER = 424242;
/** Identifiants des lignes `shadow_ref.scan_runs` de fixture. */
export const FIXTURE_SHADOW_ID_MIN = 990_000_000;

export interface OwnerState {
  readonly secretBase32: string;
  /** Pas TOTP consommé par la CLI à l'activation (rejeu refusé : la connexion doit utiliser un pas supérieur). */
  readonly enrolledStep: number;
  readonly recoveryCodes: readonly string[];
}

export function readOwnerState(): OwnerState {
  return JSON.parse(readFileSync(OWNER_STATE_FILE, 'utf8')) as OwnerState;
}

// --- TOTP (RFC 6238 : HMAC-SHA1, 6 chiffres, 30 s), réimplémenté ici pour ne dépendre d'aucune lib du banc ---
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('base32 invalide');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpStepNow(now = Date.now()): number {
  return Math.floor(now / 30_000);
}

export function totpAtStep(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/**
 * Code TOTP d'un pas strictement supérieur à `lastStep` et accepté par l'API (fenêtre ±1 pas) : attend au besoin
 * que le pas courant rattrape `lastStep` (au plus 30 s).
 */
export async function freshTotp(secretBase32: string, lastStep: number): Promise<{ code: string; step: number }> {
  const target = lastStep + 1;
  while (totpStepNow() + 1 < target) await new Promise((resolve) => setTimeout(resolve, 500));
  // Marge : si le pas courant change pendant la saisie, `target` reste dans la fenêtre [courant − 1, courant + 1].
  return { code: totpAtStep(secretBase32, target), step: target };
}

// --- Parcours ---
export async function fillLogin(page: Page, secondFactor: string): Promise<void> {
  await page.getByLabel('E-mail').fill(OWNER_EMAIL);
  await page.getByLabel('Mot de passe', { exact: true }).fill(OWNER_PASSWORD);
  await page.locator('#code').fill(secondFactor);
}

/** Aucun défilement horizontal (tolérance d'un pixel d'arrondi). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'défilement horizontal').toBeLessThanOrEqual(1);
}

/** Cibles interactives visibles plus petites que 44 × 44 px (liens dans un texte exclus, WCAG 2.5.5 / 2.5.8). */
export async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], summary';
    const found: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden') continue;
      // Lien au fil d'un paragraphe : exception « inline » des critères de taille de cible.
      if (el.tagName === 'A' && style.display === 'inline' && el.closest('p, li')) continue;
      // Case à cocher ou bouton radio : la cible réelle est son libellé (clic sur le <label> = clic sur le contrôle).
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        const label = el.closest('label') ?? (el.id ? document.querySelector<HTMLElement>(`label[for="${el.id}"]`) : null);
        const box = label?.getBoundingClientRect();
        if (box && box.width >= 44 - 0.5 && box.height >= 44 - 0.5) continue;
      }
      if (rect.width < 44 - 0.5 || rect.height < 44 - 0.5) {
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
        found.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} « ${name} » ${Math.round(rect.width)}×${Math.round(rect.height)}`);
      }
    }
    return found;
  });
}

export async function apiLogin(request: APIRequestContext, body: Record<string, unknown>) {
  return request.post(`${FRONT_ORIGIN}/api/auth/login`, { data: body, headers: { Origin: FRONT_ORIGIN }, failOnStatusCode: false });
}
