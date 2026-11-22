import { expect, request, type BrowserContext, type Page } from '@playwright/test';
import { Client as PgClient } from 'pg';
import { APP_ORIGIN, createVerifiedAccount, webStorageDump } from './auth';
import { DATABASE_URL, startTrial } from './watch';

/**
 * Scan de wallet (phase 5, docs/ARCHITECTURE.md §12) contre l'API réelle en mode fixtures
 * (`ANALYSIS_FIXTURES=1`) : wallets synthétiques de libs/api/solana (§12.10), mêmes adresses qu'api-e2e.
 */
export const WALLETS = {
  /** Délégation SPL sur tout le solde, délégation sur un compte USDC vide, délégation Token-2022 partielle. */
  delegation: 'HeESQ5wM9nFoXTgiNY2XWpK5PtiUfQ7kTvk3kk6ksZwf',
  /** Token Sain (contrôle rapide 6/9), mint actif Danger, poussière (USDC 0,40 $), NFT. */
  danger: '2Vm2knf2ywSNrKhQSgKTE3sUawpzs9GY32HYeDvA6W6N',
  /** Aucun compte de token. */
  empty: '54SpU9vgpM99H5qc91upiTYXe3i7gQ2RM78BHZoTDayp',
  /** Plus de 1 000 comptes de tokens : WALLET_TOO_LARGE. */
  tooLarge: '53Bmgioqf3gPGEKErmJtVaJrV8SoDf52nPVzeNALMaVW',
  /** Adresse d'un mint (lue on-chain, absente de la liste des mints connus) : WALLET_IS_TOKEN. */
  token: 'BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi',
  /** Programme connu des contrats (pump.fun) : refusé dès la saisie. */
  program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  /** Programme absent de la liste des contrats (Orca Whirlpool) : refusé par l'API (WALLET_INVALID). */
  programOnChain: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  /** Mint connu (USDC) : refusé dès la saisie, lien « Analyser ce token ». */
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
} as const;

/** Mints et délégués des fixtures. */
export const WALLET_MINTS = { safe: '9N3J88UmdXNRJVUCgTjuR52tWLNmzkzxg1atuBYnuRew', pyusd: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' } as const;
export const T22_DELEGATE = 'Uwbx7KF9hCB7YCYJxqZhVXD8Dhgezn7AWVWdiDDNAw8';

/**
 * Copie de `WALLET_REVOKE_GUIDE_URLS` (@raijin/shared-contracts, wallet/revoke.ts) : web-e2e n'a pas de tag Nx
 * et ne peut importer aucune lib (frontières de modules). À tenir synchronisée.
 */
export const REVOKE_GUIDE_URLS = [
  'https://help.phantom.com/articles/revoke-token-approvals-19142125651731',
  'https://www.solflare.com/glossary/token-approval/',
  'https://help.solflare.com/en/articles/9267797-understanding-delegations-aka-spending-approvals-in-solflare',
] as const;

/** Copies des messages des contrats (WALLET_ERROR_MESSAGES, ANALYSIS_DISCLAIMER). */
export const WALLET_MESSAGES = {
  tooLarge: 'Ce wallet contient trop de comptes de tokens pour un scan. Analyse plutôt les tokens un par un.',
  isToken: 'Cette adresse est celle d’un token, pas d’un wallet. Tu peux lancer son analyse.',
  quota: 'Tu as atteint ton nombre de scans de wallet pour aujourd’hui. Il se renouvelle à minuit (UTC).',
  seed: 'Ne colle jamais ta phrase de récupération : Raijin n’en a pas besoin. Efface-la et colle seulement ton adresse publique.',
  mint: 'C’est l’adresse d’un token, pas celle d’un wallet.',
  program: 'C’est l’adresse d’un programme Solana, pas celle d’un wallet.',
  apiInvalid: 'Ce n’est pas une adresse publique de wallet Solana. Copie-la depuis ton wallet (bouton Recevoir).',
  invalid: 'Adresse invalide : une adresse Solana fait 32 à 44 caractères (sans 0, O, I ni l).',
  disclaimer: 'pas un conseil en investissement',
} as const;

/** Phrase de récupération factice (12 mots BIP-39 courants, aucun wallet réel). */
export const FAKE_SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

/** Champ de saisie (le bouton « Coller » a aussi l'étiquette dans son nom). */
export const walletField = (page: Page) => page.getByRole('textbox', { name: 'Adresse publique du wallet' });
export const scanButton = (page: Page) => page.getByRole('button', { name: 'Scanner', exact: true });

/** Saisit l'adresse, lance le scan et attend la fin du chargement. */
export async function scanWallet(page: Page, address: string): Promise<void> {
  await walletField(page).fill(address);
  await scanButton(page).click();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
}

/** Scan terminé avec un résultat affiché (délégations et/ou tokens). */
export async function scanWalletResult(page: Page, address: string): Promise<void> {
  await scanWallet(page, address);
  await expect(page.locator('[data-result]')).toBeVisible({ timeout: 30_000 });
}

async function withPg<T>(run: (pg: PgClient) => Promise<T>): Promise<T> {
  const pg = new PgClient({ connectionString: DATABASE_URL });
  await pg.connect();
  try {
    return await run(pg);
  } finally {
    await pg.end();
  }
}

/** Fixe le compteur de scans du jour (UTC) d'un compte, comme api-e2e (compteur atomique `UsageCounter`). */
export function setWalletScansUsed(email: string, count: number): Promise<void> {
  return withPg(async (pg) => {
    await pg.query(
      `DELETE FROM "UsageCounter" WHERE "kind" = 'wallet_scan' AND "userId" = (SELECT "id" FROM "User" WHERE "email" = $1)`,
      [email],
    );
    if (count > 0) {
      await pg.query(
        `INSERT INTO "UsageCounter" ("id", "userId", "ipHash", "kind", "day", "count")
         SELECT gen_random_uuid(), "id", NULL, 'wallet_scan', (now() AT TIME ZONE 'utc')::date, $2 FROM "User" WHERE "email" = $1`,
        [email, count],
      );
    }
  });
}

/** Compte vérifié avec essai Pro actif (posé en base), connecté dans le contexte donné. */
export async function trialAccountIn(context: BrowserContext, prefix = 'wallet-essai'): Promise<{ email: string; password: string }> {
  const account = await createVerifiedAccount(context, prefix);
  await startTrial(account.email);
  return account;
}

let sharedTrial: Promise<{ email: string; password: string }> | undefined;

/**
 * Compte en essai Pro partagé par les tests d'un worker (écrans responsive, axe, captures) ;
 * son compteur de scans est remis à zéro à chaque ouverture (10 scans par jour en essai).
 */
export async function walletTrialAccount(): Promise<{ email: string; password: string }> {
  sharedTrial ??= (async () => {
    const api = await request.newContext({ baseURL: APP_ORIGIN, extraHTTPHeaders: { 'X-Forwarded-For': `10.251.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
    try {
      const created = await createVerifiedAccount(api, 'ecran-wallet');
      await startTrial(created.email);
      return created;
    } finally {
      await api.dispose();
    }
  })();
  const account = await sharedTrial;
  await setWalletScansUsed(account.email, 0);
  return account;
}

/** L'adresse n'apparaît ni dans l'URL, ni dans l'historique, ni dans le stockage web, ni dans les cookies. */
export async function expectAddressNotStored(page: Page, address: string): Promise<void> {
  expect(page.url(), 'URL').not.toContain(address);
  expect(await page.evaluate(() => JSON.stringify(history.state ?? null)), 'history.state').not.toContain(address);
  expect((await webStorageDump(page)).join('\n'), 'localStorage / sessionStorage').not.toContain(address);
  const cookies = await page.context().cookies();
  expect(cookies.map((c) => `${c.name}=${c.value}`).join('\n'), 'cookies').not.toContain(address);
}
