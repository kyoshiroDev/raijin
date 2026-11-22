import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Chiffrement du secret TOTP (docs/ARCHITECTURE.md §14.2) : AES-256-GCM, IV aléatoire de 12 octets par
 * chiffrement, AAD = `totp:<userId>` (un secret recopié sur une autre ligne ne se déchiffre pas).
 * Format : `v1.<iv>.<tag>.<ciphertext>` (base64url) ; le préfixe de version prépare une rotation de clé.
 */
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function totpAad(userId: string): Buffer {
  return Buffer.from(`totp:${userId}`, 'utf8');
}

export function encryptTotpSecret(key: Buffer, userId: string, secret: Buffer): string {
  if (key.length !== 32) throw new Error('TOTP_KEY_INVALID');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(totpAad(userId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** Déchiffre ; lève `TOTP_SECRET_UNREADABLE` (format, clé, AAD ou intégrité) sans jamais inclure la valeur. */
export function decryptTotpSecret(key: Buffer, userId: string, payload: string): Buffer {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('TOTP_SECRET_UNREADABLE');
  try {
    const iv = Buffer.from(parts[1] ?? '', 'base64url');
    const tag = Buffer.from(parts[2] ?? '', 'base64url');
    const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('format');
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(totpAad(userId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('TOTP_SECRET_UNREADABLE');
  }
}

/** Clé HMAC des codes de secours, dérivée de la clé TOTP (HKDF-SHA256, info `raijin-recovery-codes`). */
export function recoveryCodeKey(totpKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', totpKey, Buffer.alloc(0), 'raijin-recovery-codes', 32));
}
