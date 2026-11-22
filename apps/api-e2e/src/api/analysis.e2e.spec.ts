import { AUTH_EMAIL_LINK_PATHS, analysisResponseSchema, analysisResultSchema, quotaInfoSchema } from '@raijin/shared-contracts';
import { randomBytes } from 'node:crypto';
import { ApiClient, tokenFrom, uniqueEmail, waitForMail } from '../support/client';

/**
 * Analyse de token contre l'API réelle lancée avec `ANALYSIS_FIXTURES=1` (cible `api:serve-e2e`) :
 * les sources Solana rejouent les enregistrements de libs/api/solana/src/fixtures (aucun réseau).
 * Chaque test simule sa propre IP (X-Forwarded-For, TRUST_PROXY=1) pour un quota anonyme neuf.
 */
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BONK_PAIR = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_ACTIVE = 'BL7yQWfMeLesszudGL6TqnfWbieFMDTT1TFXzQWBazTi';
const HONEYPOT = '3Ss6A75uZG9cSRt4feyhcmJVGT38USeygDfwi1tBGQVa';
const MISSING = 'Y3Pg4fGfK1jz4exHgF2duMUhZvjAa1FdBuJYMsyZfWD';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function randomMint(): string {
  let n = BigInt(`0x${randomBytes(32).toString('hex')}`) | (1n << 255n);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

function randomIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${b[2]}`;
}

async function visitor(): Promise<ApiClient> {
  const client = new ApiClient();
  client.headers['X-Forwarded-For'] = randomIp();
  return client.init();
}

describe('API Raijin : analyse de token (sources simulées)', () => {
  it('anonyme : 200 conforme, seconde analyse servie depuis le cache, quota non recompté', async () => {
    const client = await visitor();
    const first = await client.post('/analyses', { input: BONK });
    expect(first.status).toBe(200);
    const parsed = analysisResponseSchema.parse(first.data);
    expect(parsed.analysis.mint).toBe(BONK);
    expect(parsed.quota).toMatchObject({ subject: 'anonymous', limit: 3, used: 1, remaining: 2 });
    expect(first.headers['server-timing']).toMatch(/^analysis;dur=\d+$/);
    expect(first.headers['cache-control']).toBe('no-store');

    const second = await client.post('/analyses', { input: BONK });
    expect(second.status).toBe(200);
    const again = analysisResponseSchema.parse(second.data);
    expect(again.analysis.cached).toBe(true);
    expect(again.quota.used).toBe(1);
  });

  it('quota anonyme : décrémenté par mint, 429 QUOTA_EXCEEDED au-delà, remboursé si le token n’existe pas', async () => {
    const client = await visitor();
    expect((await client.post('/analyses', { input: BONK })).status).toBe(200);
    const missing = await client.post('/analyses', { input: MISSING });
    expect(missing.status).toBe(404);
    expect(missing.data['code']).toBe('TOKEN_NOT_FOUND');
    expect(quotaInfoSchema.parse((await client.get('/analyses/quota')).data)).toMatchObject({ used: 1, remaining: 2 });

    const active = await client.post<{ analysis: { verdict: string } }>('/analyses', { input: MINT_ACTIVE });
    expect(active.status).toBe(200);
    expect(active.data.analysis.verdict).toBe('danger');
    const honeypot = await client.post<{ analysis: { verdict: string }; quota: { remaining: number } }>('/analyses', { input: HONEYPOT });
    expect(honeypot.status).toBe(200);
    expect(honeypot.data.analysis.verdict).toBe('danger');
    expect(honeypot.data.quota.remaining).toBe(0);

    const over = await client.post('/analyses', { input: USDC });
    expect(over.status).toBe(429);
    expect(over.data).toEqual({ code: 'QUOTA_EXCEEDED', message: expect.stringContaining('quota') });
  });

  it('lien DexScreener d’une paire : analyse du token de base', async () => {
    const client = await visitor();
    const res = await client.post<{ analysis: { mint: string } }>('/analyses', { input: `https://dexscreener.com/solana/${BONK_PAIR}` });
    expect(res.status).toBe(200);
    expect(res.data.analysis.mint).toBe(BONK);
  });

  it('erreurs : MINT_INVALID, VALIDATION_ERROR, CSRF', async () => {
    const client = await visitor();
    const invalid = await client.post('/analyses', { input: 'https://exemple.fr/pas-un-token' });
    expect(invalid.status).toBe(400);
    expect(invalid.data['code']).toBe('MINT_INVALID');
    const empty = await client.post('/analyses', { input: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.data['code']).toBe('VALIDATION_ERROR');
    const extra = await client.post('/analyses', { input: BONK, admin: true });
    expect(extra.status).toBe(400);
    const noCsrf = new ApiClient();
    noCsrf.headers['X-Forwarded-For'] = randomIp();
    const forbidden = await noCsrf.post('/analyses', { input: BONK });
    expect(forbidden.status).toBe(403);
    expect(forbidden.data['code']).toBe('AUTH_CSRF_INVALID');
    expect(quotaInfoSchema.parse((await client.get('/analyses/quota')).data).used).toBe(0);
  });

  it('utilisateur Gratuit connecté : quota de 5 par utilisateur ; cookie de session invalide → 401', async () => {
    const email = uniqueEmail('analyse');
    const client = await visitor();
    expect((await client.post('/auth/register', { email, password: 'une phrase de passe e2e solide', acceptTerms: true })).status).toBe(202);
    const text = await waitForMail(email, 'Confirme ton adresse');
    expect((await client.post('/auth/verify-email', { token: tokenFrom(text, AUTH_EMAIL_LINK_PATHS.verifyEmail) })).status).toBe(200);
    const quota = quotaInfoSchema.parse((await client.get('/analyses/quota')).data);
    expect(quota).toMatchObject({ subject: 'user', plan: 'FREE', limit: 5, used: 0 });
    const res = await client.post<{ quota: { subject: string; remaining: number } }>('/analyses', { input: BONK });
    expect(res.status).toBe(200);
    expect(res.data.quota).toMatchObject({ subject: 'user', remaining: 4 });

    const forged = client.clone();
    forged.cookies.set('rj_at', 'jeton.falsifie.invalide');
    // Lecture (sans CSRF) : la garde d'auth facultative refuse le cookie invalide au lieu de basculer en anonyme.
    const expired = await forged.get('/analyses/quota');
    expect(expired.status).toBe(401);
    expect(expired.data['code']).toBe('AUTH_SESSION_EXPIRED');
  });

  it('résultat publié : dernière analyse, ANALYSIS_NOT_FOUND, MINT_INVALID', async () => {
    const client = await visitor();
    await client.post('/analyses', { input: BONK });
    const latest = await client.get('/analyses/' + BONK + '/latest');
    expect(latest.status).toBe(200);
    expect(analysisResultSchema.parse(latest.data).mint).toBe(BONK);
    const never = await client.get(`/analyses/${randomMint()}/latest`);
    expect(never.status).toBe(404);
    expect(never.data['code']).toBe('ANALYSIS_NOT_FOUND');
    const bad = await client.get('/analyses/%3Cscript%3E/latest');
    expect(bad.status).toBe(400);
    expect(bad.data['code']).toBe('MINT_INVALID');
  });

  it('page publique : HTML avec balises OG et canonique ; image OG PNG 1200×630', async () => {
    const client = await visitor();
    await client.post('/analyses', { input: BONK });
    const page = await client.raw(`/share/t/${BONK}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    const html = Buffer.from(page.data).toString('utf8');
    expect(html).toMatch(/<meta property="og:title" content="[^"]+ · token DezX…B263 · Raijin Shield" \/>/);
    expect(html).toContain(`/api/v1/og/${BONK}.png`);
    expect(html).toContain('summary_large_image');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    const image = await client.raw(`/og/${BONK}.png`);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    const png = Buffer.from(image.data);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);

    const generic = await client.raw('/og/pas-un-mint.png');
    expect(generic.status).toBe(200);
    expect(generic.headers['content-type']).toBe('image/png');
  }, 60_000);
});
