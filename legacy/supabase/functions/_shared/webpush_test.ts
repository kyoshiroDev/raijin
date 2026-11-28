// Runs with `deno test supabase/functions` (node:test is supported by Deno)
// and with `node --experimental-strip-types --test` for quick local checks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64urlDecode,
  b64urlEncode,
  createVapidJwt,
  encryptPayload,
  isAllowedPushEndpoint,
  loadVapidConfig,
  sendWebPush,
  vapidPrivateJwk,
  type VapidConfig,
} from './webpush.ts';
import { corsHeaders, parseAllowedOrigins } from './cors.ts';

const subtle = globalThis.crypto.subtle;
const dec = (s: string): Uint8Array => {
  const b = b64urlDecode(s);
  if (!b) throw new Error('bad b64');
  return b;
};

async function newVapid(): Promise<VapidConfig> {
  const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64urlEncode(pub), privateKey: jwk.d ?? '', subject: 'mailto:alerts@example.com' };
}

describe('isAllowedPushEndpoint', () => {
  it('accepts the known push services', () => {
    for (const e of [
      'https://web.push.apple.com/QGuQyavXutnMH-abc',
      'https://fcm.googleapis.com/fcm/send/dXyz:APA91b',
      'https://fcm.googleapis.com/wp/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
    ]) assert.equal(isAllowedPushEndpoint(e), true, e);
  });
  it('rejects other hosts, http, lookalikes, userinfo, ports and whitespace', () => {
    for (const e of [
      'https://evil.com/push',
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com.evil.com/x',
      'https://fcm.googleapis.com@evil.com/x',
      'https://evil.com@fcm.googleapis.com/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://evilfcm.googleapis.com/x',
      'https://xfcm.googleapis.com/x',
      'https://a.b.notify.windows.com/x',
      'https://notify.windows.com/x',
      'https://evil.com/.notify.windows.com/x',
      'https://fcm.googleapis.com',
      'https://FCM.googleapis.com/x',
      'https://fcm.googleapis.com/x y',
      'https://fcm.googleapis.com/\nx',
      'https://127.0.0.1/x',
      'https://fcm.googleapis.com/' + 'a'.repeat(1000),
      'javascript:alert(1)',
      42,
      null,
    ]) assert.equal(isAllowedPushEndpoint(e), false, String(e));
  });
});

describe('base64url', () => {
  it('round-trips and tolerates padding', () => {
    const bytes = Uint8Array.from([0, 255, 251, 62, 63, 1]);
    const s = b64urlEncode(bytes);
    assert.doesNotMatch(s, /[+/=]/);
    assert.deepEqual(b64urlDecode(s), bytes);
    assert.deepEqual(b64urlDecode(s + '=='), bytes);
    assert.equal(b64urlDecode('a$b'), null);
  });
});

describe('VAPID keys', () => {
  it('builds a JWK from the web-push key format', async () => {
    const v = await newVapid();
    const jwk = vapidPrivateJwk(v.publicKey, v.privateKey);
    const pub = dec(v.publicKey);
    assert.deepEqual(dec(jwk.x ?? ''), pub.slice(1, 33));
    assert.deepEqual(dec(jwk.y ?? ''), pub.slice(33, 65));
    await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  });
  it('rejects malformed keys', () => {
    assert.throws(() => vapidPrivateJwk('AAAA', 'AAAA'));
  });
  it('loadVapidConfig returns null when missing or malformed', async () => {
    const v = await newVapid();
    const env = (o: Record<string, string>) => (k: string) => o[k];
    const full = { VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, VAPID_SUBJECT: v.subject };
    assert.deepEqual(loadVapidConfig(env(full)), v);
    assert.equal(loadVapidConfig(env({ ...full, VAPID_PRIVATE_KEY: '' })), null);
    assert.equal(loadVapidConfig(env({ ...full, VAPID_SUBJECT: 'javascript:x' })), null);
    assert.equal(loadVapidConfig(env({ ...full, VAPID_PUBLIC_KEY: 'AAAA' })), null);
  });
});

describe('VAPID JWT (RFC 8292)', () => {
  it('has ES256 header, aud/exp/sub claims and a valid signature', async () => {
    const v = await newVapid();
    const now = 1_800_000_000;
    const jwt = await createVapidJwt(v, 'https://fcm.googleapis.com', now);
    const [h, c, s] = jwt.split('.');
    const td = new TextDecoder();
    assert.deepEqual(JSON.parse(td.decode(dec(h))), { typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(td.decode(dec(c)));
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'mailto:alerts@example.com');
    assert.ok(claims.exp > now && claims.exp - now <= 12 * 3600);
    const sig = dec(s);
    assert.equal(sig.length, 64);
    const pubKey = await subtle.importKey('raw', dec(v.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sig, new TextEncoder().encode(`${h}.${c}`));
    assert.equal(ok, true);
  });
});

// RFC 8291 Appendix A test vector.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** Reference decryption (user agent side, RFC 8291 §3.4) to check round trips with random keys. */
async function decrypt(body: Uint8Array, uaPublicB64: string, uaPrivateJwk: JsonWebKey, authB64: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' } as const;
  const priv = await subtle.importKey('jwk', uaPrivateJwk, ecdh, false, ['deriveBits']);
  const asKey = await subtle.importKey('raw', asPublic, ecdh, false, []);
  const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, priv, 256));
  const hmac = async (k: Uint8Array, d: Uint8Array) =>
    new Uint8Array(await subtle.sign('HMAC', await subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), d));
  const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
  const hkdf = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    (await hmac(await hmac(s, ikm), cat(info, Uint8Array.of(1)))).slice(0, n);
  const ikm = await hkdf(dec(authB64), secret, cat(enc.encode('WebPush: info\0'), dec(uaPublicB64), asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  assert.equal(pt[pt.length - 1], 2, 'last-record delimiter');
  return new TextDecoder().decode(pt.slice(0, -1));
}

describe('encryptPayload (RFC 8291)', () => {
  it('matches the RFC 8291 Appendix A test vector byte for byte', async () => {
    const asPub = dec(RFC.asPublic);
    const body = await encryptPayload(dec(RFC.plaintext), RFC.uaPublic, RFC.auth, {
      asKeyPair: {
        privateJwk: {
          kty: 'EC',
          crv: 'P-256',
          x: b64urlEncode(asPub.slice(1, 33)),
          y: b64urlEncode(asPub.slice(33, 65)),
          d: RFC.asPrivate,
        },
        publicRaw: asPub,
      },
      salt: dec(RFC.salt),
    });
    assert.equal(b64urlEncode(body), RFC.message);
  });
  it('round-trips with a fresh ephemeral key and random salt', async () => {
    const ua = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const uaPub = b64urlEncode(new Uint8Array(await subtle.exportKey('raw', ua.publicKey)));
    const uaJwk = await subtle.exportKey('jwk', ua.privateKey);
    const auth = b64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const msg = JSON.stringify({ title: '⚡ RAIJIN · TEST 80/100' });
    const a = await encryptPayload(new TextEncoder().encode(msg), uaPub, auth);
    const b = await encryptPayload(new TextEncoder().encode(msg), uaPub, auth);
    assert.notDeepEqual(a.slice(0, 16), b.slice(0, 16), 'fresh salt per message');
    assert.equal(new DataView(a.buffer, a.byteOffset).getUint32(16), 4096);
    assert.equal(a[20], 65);
    assert.equal(await decrypt(a, uaPub, uaJwk, auth), msg);
  });
  it('rejects malformed subscription keys and oversized payloads', async () => {
    await assert.rejects(encryptPayload(new Uint8Array(1), 'AAAA', RFC.auth));
    await assert.rejects(encryptPayload(new Uint8Array(1), RFC.uaPublic, 'AAAA'));
    await assert.rejects(encryptPayload(new Uint8Array(4000), RFC.uaPublic, RFC.auth));
  });
});

describe('sendWebPush', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: RFC.uaPublic, auth: RFC.auth };

  it('posts an encrypted body with the RFC headers', async () => {
    const v = await newVapid();
    let seenUrl = '';
    let seen: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seen = init;
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const r = await sendWebPush(sub, '{"title":"x"}', v, { fetchImpl });
    assert.deepEqual(r, { status: 201, ok: true, gone: false });
    assert.equal(seenUrl, sub.endpoint);
    const h = seen?.headers as Record<string, string>;
    assert.equal(h['Content-Encoding'], 'aes128gcm');
    assert.equal(h.TTL, '3600');
    assert.equal(h.Urgency, 'normal');
    assert.match(h.Authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${v.publicKey}$`));
    assert.equal(seen?.redirect, 'manual');
    assert.ok(seen?.signal instanceof AbortSignal);
  });
  it('flags 404/410 as gone', async () => {
    const v = await newVapid();
    for (const status of [404, 410]) {
      const fetchImpl = (async () => new Response(null, { status })) as typeof fetch;
      assert.deepEqual(await sendWebPush(sub, '{}', v, { fetchImpl }), { status, ok: false, gone: true });
    }
  });
  it('never fetches a non-allowlisted endpoint', async () => {
    const v = await newVapid();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const r = await sendWebPush({ ...sub, endpoint: 'https://fcm.googleapis.com.evil.com/x' }, '{}', v, { fetchImpl });
    assert.equal(called, false);
    assert.deepEqual(r, { status: 0, ok: false, gone: false });
  });
  it('never throws on network errors', async () => {
    const v = await newVapid();
    const fetchImpl = (async () => {
      throw new TypeError('network down');
    }) as typeof fetch;
    assert.deepEqual(await sendWebPush(sub, '{}', v, { fetchImpl }), { status: 0, ok: false, gone: false });
  });
});

describe('CORS', () => {
  it('always allows the dev origin and parses ALLOWED_ORIGINS strictly', () => {
    const allowed = parseAllowedOrigins(' https://raijin.example.app , http://evil.com, https://u:p@x.com, not a url, https://ok.app/ ');
    assert.deepEqual(allowed.sort(), ['http://localhost:4200', 'https://ok.app', 'https://raijin.example.app'].sort());
  });
  it('returns headers only for allowed origins', () => {
    const allowed = parseAllowedOrigins('https://raijin.example.app');
    assert.equal(corsHeaders('https://raijin.example.app', allowed)?.['Access-Control-Allow-Origin'], 'https://raijin.example.app');
    assert.equal(corsHeaders('https://raijin.example.app.evil.com', allowed), null);
    assert.equal(corsHeaders(null, allowed), null);
  });
});
