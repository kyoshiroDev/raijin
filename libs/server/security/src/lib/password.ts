import { argon2id, hash, verify } from 'argon2';

/** Paramètres OWASP pour argon2id : m = 19 Mio, t = 2, p = 1. */
export const ARGON2_OPTIONS = { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Hache un mot de passe en argon2id (sel aléatoire, chaîne PHC `$argon2id$v=19$…`). */
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/** Vérifie un mot de passe ; `false` (jamais d'exception) si le hash est mal formé. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * Vérificateur factice (compte inexistant) : même coût qu'une vraie vérification, contre l'énumération par
 * le temps. Le hash de référence est calculé une seule fois, à la première utilisation.
 */
export function createDummyPasswordVerifier(seed: string): (password: string) => Promise<void> {
  let dummyHash: Promise<string> | null = null;
  return async (password: string) => {
    dummyHash ??= hashPassword(seed);
    await verifyPassword(await dummyHash, password);
  };
}
