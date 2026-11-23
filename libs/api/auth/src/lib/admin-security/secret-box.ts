import { recoveryCodeKey as deriveRecoveryCodeKey } from '@raijin/server-security';

/** Secret TOTP chiffré (AES-256-GCM + AAD) : implémentation partagée dans `@raijin/server-security` (§17.1). */
export { decryptTotpSecret, encryptTotpSecret, totpAad } from '@raijin/server-security';

/** Info HKDF propre à l'API Raijin (inchangée : les hashes de codes de secours existants restent valides). */
export const RAIJIN_RECOVERY_CODES_INFO = 'raijin-recovery-codes';

/** Clé HMAC des codes de secours, dérivée de la clé TOTP (HKDF-SHA256, info `raijin-recovery-codes`). */
export function recoveryCodeKey(totpKey: Buffer): Buffer {
  return deriveRecoveryCodeKey(totpKey, RAIJIN_RECOVERY_CODES_INFO);
}
