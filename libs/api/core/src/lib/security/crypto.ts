import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Jeton opaque aléatoire (32 octets par défaut), encodé en base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Empreinte SHA-256 (hex) : stockage des jetons opaques (refresh, liens e-mail). */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** HMAC-SHA-256 encodé en base64url. */
export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('base64url');
}

/** Comparaison en temps constant de deux chaînes (fausse si longueurs différentes). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
