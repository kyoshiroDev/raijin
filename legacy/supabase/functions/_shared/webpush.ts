// Web Push sender: RFC 8291 (message encryption, aes128gcm / RFC 8188) + RFC 8292 (VAPID, ES256 JWT).
// Web Crypto only (globalThis.crypto.subtle): runs on Supabase Edge Runtime / Deno and on Node >= 20 for tests.
// No Node `crypto` import, no third-party dependency.

const enc = new TextEncoder();
const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
/** Copies bytes into a plain ArrayBuffer (portable BufferSource across TS/lib versions). */
const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer;

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url (or base64), padding optional. Returns null on invalid input. */
export function b64urlDecode(input: string): Uint8Array | null {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_\-+/]*={0,2}$/.test(input)) return null;
  const s = input.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s.length % 4 === 1) return null;
  try {
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Endpoint allowlist (SSRF defense, mirrors the CHECK on push_subscriptions.endpoint)
// ---------------------------------------------------------------------------
export const PUSH_ENDPOINT_PATTERN =
  /^https:\/\/(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)\//;
const EXACT_PUSH_HOSTS = new Set(['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com']);
const WINDOWS_HOST = /^[a-z0-9-]+\.notify\.windows\.com$/;

/** True only for https URLs on a known push service host (no credentials, no port, no whitespace). */
export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || /\s/.test(endpoint)) return false;
  if (!PUSH_ENDPOINT_PATTERN.test(endpoint)) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname;
  return EXACT_PUSH_HOSTS.has(host) || WINDOWS_HOST.test(host);
}

// ---------------------------------------------------------------------------
// VAPID keys (standard `web-push` format)
// ---------------------------------------------------------------------------
export interface VapidConfig {
  /** base64url uncompressed P-256 point (65 bytes, 0x04 || x || y). */
  publicKey: string;
  /** base64url raw private scalar d (32 bytes). */
  privateKey: string;
  /** mailto: or https: contact (RFC 8292 `sub`). */
  subject: string;
}

/** Builds the ECDSA P-256 private JWK from the web-push key pair. Throws on malformed keys. */
export function vapidPrivateJwk(publicKey: string, privateKey: string): JsonWebKey {
  const pub = b64urlDecode(publicKey);
  const d = b64urlDecode(privateKey);
  if (!pub || pub.length !== 65 || pub[0] !== 0x04) throw new Error('invalid VAPID public key');
  if (!d || d.length !== 32) throw new Error('invalid VAPID private key');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: b64urlEncode(d),
    ext: false,
  };
}

/** Reads VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT. Returns null if missing or malformed (never throws, never logs). */
export function loadVapidConfig(get: (name: string) => string | undefined): VapidConfig | null {
  const publicKey = get('VAPID_PUBLIC_KEY')?.trim();
  const privateKey = get('VAPID_PRIVATE_KEY')?.trim();
  const subject = get('VAPID_SUBJECT')?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:[^\s]+@[^\s]+|https:\/\/[^\s]+)$/.test(subject) || subject.length > 200) return null;
  try {
    vapidPrivateJwk(publicKey, privateKey);
  } catch {
    return null;
  }
  return { publicKey, privateKey, subject };
}

export const VAPID_JWT_TTL_SECONDS = 12 * 60 * 60;

/** Signs a VAPID JWT (ES256). `aud` = origin of the push endpoint. */
export async function createVapidJwt(
  vapid: VapidConfig,
  audience: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await subtle().importKey(
    'jwk',
    vapidPrivateJwk(vapid.publicKey, vapid.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    enc.encode(JSON.stringify({ aud: audience, exp: nowSeconds + VAPID_JWT_TTL_SECONDS, sub: vapid.subject })),
  );
  const signingInput = `${header}.${claims}`;
  // Web Crypto returns the raw r || s (IEEE P1363) signature, which is exactly the JWS ES256 format.
  const sig = new Uint8Array(
    await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(enc.encode(signingInput))),
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}

// ---------------------------------------------------------------------------
// RFC 8291 encryption
// ---------------------------------------------------------------------------
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, buf(data)));
}

/** HKDF (RFC 5869) with a single expand block (length <= 32). */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, Uint8Array.of(1)));
  return okm.slice(0, length);
}

export const RECORD_SIZE = 4096;
export const MAX_PLAINTEXT_BYTES = 3000;

export interface EncryptOptions {
  /** Test hook: application server ECDH key pair (production generates a fresh one per message). */
  asKeyPair?: { privateJwk: JsonWebKey; publicRaw: Uint8Array };
  /** Test hook: 16-byte salt (production uses crypto.getRandomValues). */
  salt?: Uint8Array;
}

/**
 * Encrypts `plaintext` for a subscription (RFC 8291 §3.4, aes128gcm single record).
 * Returns the full request body: salt(16) || rs(4) || idlen(1) || as_public(65) || ciphertext.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  authSecret: string,
  opts: EncryptOptions = {},
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dh);
  const auth = b64urlDecode(authSecret);
  if (!uaPublic || uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('invalid p256dh');
  if (!auth || auth.length !== 16) throw new Error('invalid auth secret');
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('payload too large');

  const ecdh = { name: 'ECDH', namedCurve: 'P-256' } as const;
  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (opts.asKeyPair) {
    asPrivate = await subtle().importKey('jwk', opts.asKeyPair.privateJwk, ecdh, false, ['deriveBits']);
    asPublic = opts.asKeyPair.publicRaw;
  } else {
    const pair = (await subtle().generateKey(ecdh, true, ['deriveBits'])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  }
  const uaKey = await subtle().importKey('raw', buf(uaPublic), ecdh, false, []);
  const ecdhSecret = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);

  const salt = opts.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('invalid salt');
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await subtle().importKey('raw', buf(cek), { name: 'AES-GCM' }, false, ['encrypt']);
  // Single (last) record: plaintext || 0x02 delimiter, no padding.
  const ciphertext = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: buf(nonce) }, aesKey, buf(concat(plaintext, Uint8Array.of(2)))),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendResult {
  /** HTTP status, or 0 if nothing was sent (invalid endpoint/keys, network error, timeout). */
  status: number;
  ok: boolean;
  /** 404/410: the subscription is dead and must be deleted. */
  gone: boolean;
}

export interface SendOptions {
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Reuses VAPID JWTs per audience within one invocation. */
  jwtCache?: Map<string, Promise<string>>;
}

/** Sends one encrypted push. Never throws; never logs endpoints or keys. */
export async function sendWebPush(
  sub: PushSubscriptionKeys,
  payload: string,
  vapid: VapidConfig,
  opts: SendOptions = {},
): Promise<SendResult> {
  if (!isAllowedPushEndpoint(sub.endpoint)) return { status: 0, ok: false, gone: false };
  try {
    const audience = new URL(sub.endpoint).origin;
    let jwt = opts.jwtCache?.get(audience);
    if (!jwt) {
      jwt = createVapidJwt(vapid, audience);
      opts.jwtCache?.set(audience, jwt);
    }
    const body = await encryptPayload(enc.encode(payload), sub.p256dh, sub.auth);
    const res = await (opts.fetchImpl ?? fetch)(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(opts.ttl ?? 3600),
        Urgency: opts.urgency ?? 'normal',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: `vapid t=${await jwt}, k=${vapid.publicKey}`,
      },
      body: buf(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410 };
  } catch {
    return { status: 0, ok: false, gone: false };
  }
}
