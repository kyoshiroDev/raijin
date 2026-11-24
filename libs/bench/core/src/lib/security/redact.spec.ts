import { errorCodeOf, redactSecrets, safeErrorMessage } from './redact';

describe('nettoyage des erreurs', () => {
  it('retire identifiants d’URL, paramètres sensibles, Bearer, affectations et longues clés ; garde les mints', () => {
    const mint = 'So11111111111111111111111111111111111111112';
    const text = redactSecrets(
      `redis://:motdepasse@raijin-redis:6379 https://api.helius.xyz/v0?api-key=SECRET&x=1 Bearer abc.def.ghi TOTP_ENCRYPTION_KEY=zzz ${'f'.repeat(64)} ${mint}`,
    );
    expect(text).not.toMatch(/motdepasse|SECRET|abc\.def|zzz|f{64}/);
    expect(text).toContain(mint);
    expect(text).toContain('api-key=***');
  });

  it('message borné, sans saut de ligne ; codes sûrs', () => {
    expect(safeErrorMessage(new TypeError('a\nb'), 500)).toBe('TypeError: a b');
    expect(safeErrorMessage('mot '.repeat(200), 500)).toHaveLength(500);
    expect(safeErrorMessage({ objet: true }, 500)).toBe('Erreur inconnue');
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'avec espace' }))).toBe('Error');
    expect(errorCodeOf(null)).toBe('UNKNOWN');
  });
});
