import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from '@raijin/shared-contracts';

/**
 * TOTP (RFC 6238) sur HOTP (RFC 4226), implémenté avec `node:crypto` seulement (docs/ARCHITECTURE.md §14.2) :
 * HMAC-SHA1, 6 chiffres, pas de 30 s, fenêtre ±1 pas. Secret de 20 octets, encodé en base32 (RFC 4648, sans `=`).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Taille du secret (160 bits, recommandation RFC 4226). */
export const TOTP_SECRET_BYTES = 20;
/** Pas tolérés de part et d'autre du pas courant (décalage d'horloge du téléphone). */
export const TOTP_WINDOW = 1;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('BASE32_INVALID');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** Pas TOTP de l'instant donné. */
export function totpStep(now: Date, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(now.getTime() / 1000 / period);
}

/** HOTP (RFC 4226 §5.3) : troncature dynamique d'un HMAC du compteur sur 8 octets. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS, algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return binary.toString().padStart(digits, '0');
}

export function totpAt(secret: Buffer, now: Date, digits = TOTP_DIGITS, algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  return hotp(secret, totpStep(now), digits, algorithm);
}

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Pas correspondant au code dans la fenêtre ±1, ou `null`. Un pas inférieur ou égal à `lastUsedStep` est refusé
 * (rejeu). Tous les pas de la fenêtre sont calculés (temps constant vis-à-vis de la position du code).
 */
export function matchTotp(secret: Buffer, code: string, now: Date, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(now);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step += 1) {
    if (sameCode(hotp(secret, step), code) && (lastUsedStep === null || step > lastUsedStep) && matched === null) matched = step;
  }
  return matched;
}

/** URI `otpauth://` (format Key URI de Google Authenticator) lue par les applications d'authentification. */
export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
