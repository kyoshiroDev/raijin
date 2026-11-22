import { recoveryCodeSchema } from '@raijin/shared-contracts';
import { generateRecoveryCode, generateRecoveryCodes, hashRecoveryCode } from './recovery-codes';

const KEY = Buffer.alloc(32, 3);
const USER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('codes de secours', () => {
  it('format XXXXX-XXXXX accepté par le contrat', () => {
    for (let index = 0; index < 100; index += 1) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      expect(recoveryCodeSchema.parse(code)).toBe(code);
    }
  });

  it('10 codes distincts', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('hash HMAC lié au compte, insensible à la casse et aux espaces, jamais le code en clair', () => {
    const hash = hashRecoveryCode(KEY, USER, 'ABCDE-FGH23');
    expect(hashRecoveryCode(KEY, USER, ' abcde-fgh23 ')).toBe(hash);
    expect(hashRecoveryCode(KEY, '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c', 'ABCDE-FGH23')).not.toBe(hash);
    expect(hashRecoveryCode(Buffer.alloc(32, 4), USER, 'ABCDE-FGH23')).not.toBe(hash);
    expect(hash).not.toContain('ABCDE');
  });
});
