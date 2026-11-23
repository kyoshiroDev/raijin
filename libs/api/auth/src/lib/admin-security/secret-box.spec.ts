import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { decryptTotpSecret, encryptTotpSecret, recoveryCodeKey, totpAad } from './secret-box';
import { hashRecoveryCode } from './recovery-codes';
import { base32Encode, matchTotp, totpAt } from './totp';

const KEY = Buffer.alloc(32, 7);
const USER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

/** Les tests détaillés vivent dans `@raijin/server-security` ; ici, le câblage propre à l'API Raijin. */
describe('secret-box (API Raijin, via @raijin/server-security)', () => {
  it('aller-retour du secret TOTP et AAD totp:<userId> inchangés', () => {
    const secret = randomBytes(20);
    expect(decryptTotpSecret(KEY, USER, encryptTotpSecret(KEY, USER, secret)).equals(secret)).toBe(true);
    expect(totpAad(USER).toString()).toBe(`totp:${USER}`);
    expect(() => encryptTotpSecret(Buffer.alloc(16), USER, secret)).toThrow('TOTP_KEY_INVALID');
  });

  it('clé des codes de secours identique à avant l’extraction (HKDF, info raijin-recovery-codes)', () => {
    const expected = Buffer.from(hkdfSync('sha256', KEY, Buffer.alloc(0), 'raijin-recovery-codes', 32));
    expect(recoveryCodeKey(KEY).equals(expected)).toBe(true);
    const hash = hashRecoveryCode(recoveryCodeKey(KEY), USER, 'abcde-fgh23');
    expect(hash).toBe(createHmac('sha256', expected).update(`${USER}:ABCDE-FGH23`, 'utf8').digest('base64url'));
  });

  it('réexports TOTP', () => {
    const secret = Buffer.from('12345678901234567890', 'ascii');
    const now = new Date(59_000);
    expect(base32Encode(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(matchTotp(secret, totpAt(secret, now), now, null)).not.toBeNull();
  });
});
