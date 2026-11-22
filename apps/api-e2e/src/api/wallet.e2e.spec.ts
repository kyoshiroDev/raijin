import { AUTH_EMAIL_LINK_PATHS, walletScanQuotaResponseSchema, walletScanResponseSchema, type WalletScanResponse } from '@raijin/shared-contracts';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client as PgClient } from 'pg';
import { ApiClient, tokenFrom, uniqueEmail, waitForMail } from '../support/client';

/**
 * Scan de wallet (phase 5) contre l'API réelle (Postgres, Redis), sources simulées
 * (`ANALYSIS_FIXTURES=1`) : collecte réelle (`listWalletHoldings`, `collectFactsLightBatch`) rejouée
 * depuis les fixtures de wallets synthétiques de `@raijin/api-solana` (docs/ARCHITECTURE.md §12.10).
 */
const WALLETS = {
  delegation: 'HeESQ5wM9nFoXTgiNY2XWpK5PtiUfQ7kTvk3kk6ksZwf',
  danger: '2Vm2knf2ywSNrKhQSgKTE3sUawpzs9GY32HYeDvA6W6N',
  empty: '54SpU9vgpM99H5qc91upiTYXe3i7gQ2RM78BHZoTDayp',
  program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  tooLarge: '53Bmgioqf3gPGEKErmJtVaJrV8SoDf52nPVzeNALMaVW',
};
const MINT_ACTIVE = 'BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const T22_DELEGATE = 'Uwbx7KF9hCB7YCYJxqZhVXD8Dhgezn7AWVWdiDDNAw8';
const PASSWORD = 'une phrase de passe e2e solide';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://raijin:changeme-factice@localhost:5433/raijin?schema=public';

function randomIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

async function sql<T = Record<string, unknown>>(query: string, params: unknown[]): Promise<T[]> {
  const pg = new PgClient({ connectionString: DATABASE_URL });
  await pg.connect();
  try {
    return (await pg.query(query, params)).rows as T[];
  } finally {
    await pg.end();
  }
}

async function verifiedUser(prefix: string, plan: 'free' | 'pro' | 'trial'): Promise<{ client: ApiClient; email: string }> {
  const email = uniqueEmail(prefix);
  const client = new ApiClient();
  client.headers['X-Forwarded-For'] = randomIp();
  await client.init();
  expect((await client.post('/auth/register', { email, password: PASSWORD, acceptTerms: true })).status).toBe(202);
  const text = await waitForMail(email, 'Confirme ton adresse');
  expect((await client.post('/auth/verify-email', { token: tokenFrom(text, AUTH_EMAIL_LINK_PATHS.verifyEmail) })).status).toBe(200);
  if (plan === 'pro') await sql(`UPDATE "User" SET "plan" = 'PRO' WHERE "email" = $1`, [email]);
  if (plan === 'trial') await sql(`UPDATE "User" SET "trialStatus" = 'ACTIVE', "trialEndsAt" = now() + interval '7 days' WHERE "email" = $1`, [email]);
  return { client, email };
}

describe('Scan de wallet (e2e)', () => {
  it('sans session : 401 ; sans jeton CSRF : 403', async () => {
    const anonymous = await new ApiClient().init();
    expect((await anonymous.post('/wallet-scans', { address: WALLETS.danger })).data).toMatchObject({ code: 'UNAUTHORIZED' });
    expect((await anonymous.get('/wallet-scans/quota')).status).toBe(401);
    const { client } = await verifiedUser('wallet-csrf', 'pro');
    const noCsrf = client.clone();
    noCsrf.csrfToken = '';
    const res = await noCsrf.post('/wallet-scans', { address: WALLETS.danger });
    expect(res.status).toBe(403);
    expect(res.data).toMatchObject({ code: 'AUTH_CSRF_INVALID' });
  });

  it('Gratuit : 403 WALLET_SCAN_PLAN_REQUIRED, quota non autorisé', async () => {
    const { client } = await verifiedUser('wallet-free', 'free');
    const quota = await client.get('/wallet-scans/quota');
    expect(quota.status).toBe(200);
    expect(quota.data).toEqual({ allowed: false, quota: null });
    const res = await client.post('/wallet-scans', { address: WALLETS.danger });
    expect(res.status).toBe(403);
    expect(res.data).toMatchObject({ code: 'WALLET_SCAN_PLAN_REQUIRED' });
  });

  it('Pro : wallet avec délégations (SPL sur compte vide + Token-2022), puis token Danger, cache', async () => {
    const { client, email } = await verifiedUser('wallet-pro', 'pro');
    const quota = await client.get('/wallet-scans/quota');
    expect(walletScanQuotaResponseSchema.safeParse(quota.data).success).toBe(true);
    expect(quota.data).toMatchObject({ allowed: true, quota: { kind: 'wallet_scan', plan: 'PRO', limit: 20, used: 0 } });

    const res = await client.post<WalletScanResponse>('/wallet-scans', { address: WALLETS.delegation });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(walletScanResponseSchema.safeParse(res.data).success).toBe(true);
    const { scan } = res.data;
    expect(scan.summary.delegationCount).toBe(3);
    // Délégations couvrant tout le solde d'abord (dont celle d'un compte vide).
    expect(scan.delegations.slice(0, 2).every((delegation) => delegation.coversFullBalance)).toBe(true);
    expect(scan.delegations.some((delegation) => delegation.balance.raw === '0')).toBe(true);
    expect(scan.delegations[2]).toMatchObject({ delegate: T22_DELEGATE, tokenProgram: 'token-2022', coversFullBalance: false });
    // Verdict rapide, ou analyse complète de moins d'une heure réutilisée (PYUSD analysé par analysis.e2e).
    expect(scan.tokens.every((token) => token.assessment.status === 'analyzed')).toBe(true);
    expect(res.data.quota).toMatchObject({ used: 1, remaining: 19 });

    const danger = await client.post<WalletScanResponse>('/wallet-scans', { address: WALLETS.danger });
    expect(danger.status).toBe(200);
    const token = danger.data.scan.tokens.find((item) => item.mint === MINT_ACTIVE);
    // Verdict rapide, ou analyse complète de moins d'une heure réutilisée (ex. lancée par analysis.e2e).
    expect(token?.assessment).toMatchObject({ status: 'analyzed', verdict: 'danger' });
    expect(['light', 'full']).toContain(token?.assessment.status === 'analyzed' ? token.assessment.coverage : null);
    expect(danger.data.scan.summary.verdicts.danger).toBeGreaterThanOrEqual(1);
    expect(danger.data.scan.summary).toMatchObject({ dustCount: 1, nftCount: 1 });

    // Même wallet re-scanné : cache (≤ 120 s), quota non recompté.
    const again = await client.post<WalletScanResponse>('/wallet-scans', { address: WALLETS.danger });
    expect(again.data.scan.cached).toBe(true);
    expect(again.data.quota.used).toBe(2);

    // RGPD : aucune adresse en base (événement sans adresse ni mint) ni dans les journaux de l'API.
    const events = await sql<{ properties: Record<string, unknown> }>(
      `SELECT e."properties" FROM "ProductEvent" e JOIN "User" u ON u."id" = e."userId" WHERE u."email" = $1 AND e."type" = 'wallet_scanned'`,
      [email],
    );
    expect(events).toHaveLength(3);
    expect(events[0]?.properties).toMatchObject({ plan: 'PRO', trialActive: false });
    const dump = JSON.stringify(events);
    for (const value of [WALLETS.delegation, WALLETS.danger, MINT_ACTIVE, T22_DELEGATE]) expect(dump).not.toContain(value);
    const log = readFileSync(join(__dirname, '..', '..', '..', '..', 'dist', 'api-e2e', 'api.log'), 'utf8');
    for (const value of [WALLETS.delegation, WALLETS.danger, T22_DELEGATE]) expect(log).not.toContain(value);
  });

  it('erreurs : mint collé 422 (connu ou lu on-chain), programme 400, saisie invalide 400, wallet trop gros 422 (quota remboursé)', async () => {
    const { client } = await verifiedUser('wallet-errors', 'pro');
    const expectations: [unknown, number, string][] = [
      [{ address: BONK }, 422, 'WALLET_IS_TOKEN'],
      [{ address: MINT_ACTIVE }, 422, 'WALLET_IS_TOKEN'],
      [{ address: 'pas une adresse' }, 400, 'WALLET_INVALID'],
      [{ address: WALLETS.program }, 400, 'WALLET_INVALID'],
      [{ address: WALLETS.tooLarge }, 422, 'WALLET_TOO_LARGE'],
    ];
    for (const [body, status, code] of expectations) {
      const res = await client.post('/wallet-scans', body);
      expect({ status: res.status, code: res.data['code'] }).toEqual({ status, code });
      expect(typeof res.data['message']).toBe('string');
      expect(res.data['stack']).toBeUndefined();
    }
    const quota = await client.get('/wallet-scans/quota');
    expect(quota.data).toMatchObject({ quota: { used: 0 } });
  });

  it('essai Pro : 10 scans par jour (compteur en base), puis 429 WALLET_SCAN_QUOTA_EXCEEDED ; wallet vide', async () => {
    const { client, email } = await verifiedUser('wallet-trial', 'trial');
    // 9 scans déjà comptés aujourd'hui (jour UTC), posés directement dans le compteur atomique.
    await sql(
      `INSERT INTO "UsageCounter" ("id", "userId", "ipHash", "kind", "day", "count")
       SELECT gen_random_uuid(), "id", NULL, 'wallet_scan', (now() AT TIME ZONE 'utc')::date, 9 FROM "User" WHERE "email" = $1`,
      [email],
    );
    expect((await client.get('/wallet-scans/quota')).data).toMatchObject({ allowed: true, quota: { limit: 10, used: 9, remaining: 1 } });
    const empty = await client.post<WalletScanResponse>('/wallet-scans', { address: WALLETS.empty });
    expect(empty.status).toBe(200);
    expect(empty.data.scan.summary).toMatchObject({ tokenCount: 0, delegationCount: 0 });
    expect(empty.data.quota).toMatchObject({ limit: 10, used: 10, remaining: 0 });
    const res = await client.post('/wallet-scans', { address: WALLETS.delegation });
    expect(res.status).toBe(429);
    expect(res.data).toMatchObject({ code: 'WALLET_SCAN_QUOTA_EXCEEDED' });
    expect((await client.get('/wallet-scans/quota')).data).toMatchObject({ quota: { used: 10, remaining: 0 } });
  });
});
