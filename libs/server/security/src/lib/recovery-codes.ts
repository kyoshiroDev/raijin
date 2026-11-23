import { createHmac, randomInt } from 'node:crypto';
import { ADMIN_RECOVERY_CODE_COUNT } from '@raijin/shared-contracts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Code `XXXXX-XXXXX` (base32 majuscules, 50 bits d'entropie, `randomInt` cryptographique). */
export function generateRecoveryCode(): string {
  let raw = '';
  for (let index = 0; index < 10; index += 1) raw += ALPHABET[randomInt(32)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function generateRecoveryCodes(count = ADMIN_RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateRecoveryCode());
  return [...codes];
}

/** HMAC-SHA256 (clé dérivée) du code normalisé, lié au compte : seul ce hash est stocké. */
export function hashRecoveryCode(key: Buffer, userId: string, code: string): string {
  const normalized = code.replace(/\s+/g, '').toUpperCase();
  return createHmac('sha256', key).update(`${userId}:${normalized}`, 'utf8').digest('base64url');
}
