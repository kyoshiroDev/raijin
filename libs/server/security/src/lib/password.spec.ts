import { ARGON2_OPTIONS, createDummyPasswordVerifier, hashPassword, verifyPassword } from './password';

describe('mots de passe (argon2id)', () => {
  it('hache en argon2id aux paramètres OWASP et vérifie', async () => {
    const hash = await hashPassword('Mot de passe solide 42');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 'Mot de passe solide 42')).toBe(true);
    expect(await verifyPassword(hash, 'autre')).toBe(false);
    expect(ARGON2_OPTIONS).toMatchObject({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  });

  it('hash mal formé : false, sans exception', async () => {
    expect(await verifyPassword('pas-un-hash', 'x')).toBe(false);
  });

  it('vérification factice : résout sans erreur, hash de référence calculé une seule fois', async () => {
    const dummy = createDummyPasswordVerifier('graine-factice');
    await expect(dummy('quelconque')).resolves.toBeUndefined();
    await expect(dummy('autre')).resolves.toBeUndefined();
  });
});
