/** TOTP (RFC 6238) : implémentation partagée dans `@raijin/server-security` (docs/ARCHITECTURE.md §17.1). */
export {
  TOTP_SECRET_BYTES,
  TOTP_WINDOW,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotp,
  otpauthUri,
  totpAt,
  totpStep,
} from '@raijin/server-security';
