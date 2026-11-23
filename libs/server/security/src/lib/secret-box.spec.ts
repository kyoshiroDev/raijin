import { randomBytes } from 'node:crypto';
import { decryptTotpSecret, encryptTotpSecret, recoveryCodeKey, totpAad } from './secret-box';

const KEY = Buffer.alloc(32, 7);
const USER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

describe('secret TOTP chiffré (AES-256-GCM + AAD)', () => {
  const secret = randomBytes(20);

  it('aller-retour, format v1.<iv>.<tag>.<ciphertext>', () => {
    const payload = encryptTotpSecret(KEY, USER, secret);
    expect(payload).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(decryptTotpSecret(KEY, USER, payload).equals(secret)).toBe(true);
    expect(payload).not.toContain(secret.toString('base64url'));
  });

  it('IV unique à chaque chiffrement', () => {
    const ivs = new Set(Array.from({ length: 50 }, () => encryptTotpSecret(KEY, USER, secret).split('.')[1]));
    expect(ivs.size).toBe(50);
  });

  it('AAD : un secret recopié sur une autre ligne ne se déchiffre pas', () => {
    const payload = encryptTotpSecret(KEY, USER, secret);
    expect(() => decryptTotpSecret(KEY, OTHER, payload)).toThrow('TOTP_SECRET_UNREADABLE');
    expect(totpAad(USER).toString()).toBe(`totp:${USER}`);
  });

  it('mauvaise clé, altération, format ou version inconnus : refusés sans fuite de valeur', () => {
    const payload = encryptTotpSecret(KEY, USER, secret);
    expect(() => decryptTotpSecret(Buffer.alloc(32, 8), USER, payload)).toThrow('TOTP_SECRET_UNREADABLE');
    const parts = payload.split('.');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('x'.repeat(20)).toString('base64url')].join('.');
    expect(() => decryptTotpSecret(KEY, USER, tampered)).toThrow('TOTP_SECRET_UNREADABLE');
    expect(() => decryptTotpSecret(KEY, USER, `v2.${parts.slice(1).join('.')}`)).toThrow('TOTP_SECRET_UNREADABLE');
    expect(() => decryptTotpSecret(KEY, USER, 'v1.a.b')).toThrow('TOTP_SECRET_UNREADABLE');
    expect(() => decryptTotpSecret(KEY, USER, ['v1', 'AA', parts[2], parts[3]].join('.'))).toThrow('TOTP_SECRET_UNREADABLE');
  });

  it('clé de longueur invalide refusée', () => {
    expect(() => encryptTotpSecret(Buffer.alloc(16), USER, secret)).toThrow('TOTP_KEY_INVALID');
  });

  it('clé des codes de secours dérivée (HKDF), distincte de la clé TOTP et stable', () => {
    const derived = recoveryCodeKey(KEY, 'app-a-recovery-codes');
    expect(derived).toHaveLength(32);
    expect(derived.equals(KEY)).toBe(false);
    expect(recoveryCodeKey(KEY, 'app-a-recovery-codes').equals(derived)).toBe(true);
  });

  it('info HKDF propre à chaque application : clés dérivées distinctes, info vide refusée', () => {
    expect(recoveryCodeKey(KEY, 'app-a-recovery-codes').equals(recoveryCodeKey(KEY, 'app-b-recovery-codes'))).toBe(false);
    expect(() => recoveryCodeKey(KEY, '')).toThrow('RECOVERY_KEY_INFO_REQUIRED');
  });
});
