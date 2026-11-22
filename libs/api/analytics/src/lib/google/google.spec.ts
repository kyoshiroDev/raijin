import { createVerify, generateKeyPairSync } from 'node:crypto';
import { GOOGLE_SCOPES, GOOGLE_TOKEN_URL, GoogleTokenProvider, signServiceAccountJwt } from './google-auth';
import { GoogleApiError, errorFromStatus, postJson, type FetchFn } from './google-http';
import { parseServiceAccount } from './service-account';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const EMAIL = 'raijin-admin@raijin-test.iam.gserviceaccount.com';
const JSON_KEY = JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key: PEM, project_id: 'raijin-test' });

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('parseServiceAccount', () => {
  it('JSON brut ou base64, champs utiles seulement', () => {
    expect(parseServiceAccount(JSON_KEY)).toEqual({ clientEmail: EMAIL, privateKey: PEM });
    expect(parseServiceAccount(Buffer.from(JSON_KEY).toString('base64'))?.clientEmail).toBe(EMAIL);
    // Clé avec des « \n » échappés (copie d'une ligne de .env).
    const escaped = JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key: PEM.replace(/\n/g, '\\n') });
    expect(parseServiceAccount(escaped)?.privateKey).toBe(PEM);
  });

  it('refuse un JSON illisible, un autre type, un e-mail hors compte de service, une clé invalide', () => {
    expect(parseServiceAccount('pas du json')).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ type: 'authorized_user', client_email: EMAIL, private_key: PEM }))).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ client_email: 'moi@gmail.com', private_key: PEM }))).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ client_email: EMAIL, private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }))).toBeNull();
  });
});

describe('JWT RS256 du compte de service', () => {
  it('signé avec node:crypto, portées en lecture seule, audience OAuth fixe, 1 h', () => {
    const jwt = signServiceAccountJwt({ clientEmail: EMAIL, privateKey: PEM }, Date.parse('2026-11-22T10:00:00Z'));
    const [header, payload, signature] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims).toMatchObject({ iss: EMAIL, aud: GOOGLE_TOKEN_URL, scope: GOOGLE_SCOPES.join(' ') });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(claims.scope).not.toMatch(/analytics(?!\.readonly)|webmasters(?!\.readonly)/);
    const verify = createVerify('RSA-SHA256');
    verify.update(`${header}.${payload}`);
    expect(verify.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('jeton gardé en mémoire jusqu’à 5 min avant expiration, un seul échange concurrent', async () => {
    let now = 0;
    const fetchFn = jest.fn<Promise<Response>, Parameters<FetchFn>>(async () => response(200, { access_token: 'ya29.jeton', expires_in: 3600 }));
    const tokens = new GoogleTokenProvider({ clientEmail: EMAIL, privateKey: PEM }, fetchFn, () => now);
    const [a, b] = await Promise.all([tokens.accessToken(), tokens.accessToken()]);
    expect(a).toBe('ya29.jeton');
    expect(b).toBe('ya29.jeton');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(GOOGLE_TOKEN_URL);
    expect(String(fetchFn.mock.calls[0]?.[1]?.body)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    now = 54 * 60_000;
    await tokens.accessToken();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 56 * 60_000;
    await tokens.accessToken();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('clé refusée par Google (400 invalid_grant) → auth_failed, sans reprendre le corps', async () => {
    const fetchFn: FetchFn = async () => response(400, { error: 'invalid_grant', error_description: `compte ${EMAIL}` });
    const tokens = new GoogleTokenProvider({ clientEmail: EMAIL, privateKey: PEM }, fetchFn);
    const error = await tokens.accessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect((error as GoogleApiError).code).toBe('auth_failed');
    expect((error as Error).message).not.toContain(EMAIL);
  });

  it('réponse sans jeton → auth_failed', async () => {
    const tokens = new GoogleTokenProvider({ clientEmail: EMAIL, privateKey: PEM }, async () => response(200, {}));
    await expect(tokens.accessToken()).rejects.toMatchObject({ code: 'auth_failed' });
  });
});

describe('postJson', () => {
  it('statuts traduits en codes internes', () => {
    expect(errorFromStatus(401)).toBe('auth_failed');
    expect(errorFromStatus(403)).toBe('permission_denied');
    expect(errorFromStatus(404)).toBe('permission_denied');
    expect(errorFromStatus(429)).toBe('quota_exceeded');
    expect(errorFromStatus(500)).toBe('unavailable');
  });

  it('une reprise sur 5xx ou panne réseau, aucune sur 4xx ; redirections refusées', async () => {
    const flaky = jest.fn<Promise<Response>, Parameters<FetchFn>>().mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200, { ok: 1 }));
    await expect(postJson(flaky, 'https://exemple.test', {}, {})).resolves.toEqual({ ok: 1 });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(flaky.mock.calls[0]?.[1]?.redirect).toBe('error');

    const down = jest.fn<Promise<Response>, Parameters<FetchFn>>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(postJson(down, 'https://exemple.test', {}, {})).rejects.toMatchObject({ code: 'unavailable', status: null });
    expect(down).toHaveBeenCalledTimes(2);

    const quota = jest.fn<Promise<Response>, Parameters<FetchFn>>(async () => response(429));
    await expect(postJson(quota, 'https://exemple.test', {}, {})).rejects.toMatchObject({ code: 'quota_exceeded', status: 429 });
    expect(quota).toHaveBeenCalledTimes(1);
  });

  it('JSON illisible → unavailable', async () => {
    const fetchFn: FetchFn = async () => new Response('<html>', { status: 200 });
    await expect(postJson(fetchFn, 'https://exemple.test', {}, {})).rejects.toMatchObject({ code: 'unavailable' });
  });
});
