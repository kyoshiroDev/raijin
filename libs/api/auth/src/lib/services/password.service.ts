import { Injectable } from '@nestjs/common';
import { createDummyPasswordVerifier, hashPassword, verifyPassword } from '@raijin/server-security';

/** Paramètres argon2id (OWASP), définis dans `@raijin/server-security` (docs/ARCHITECTURE.md §17.1). */
export { ARGON2_OPTIONS } from '@raijin/server-security';

/** Hachage et vérification des mots de passe (argon2id). */
@Injectable()
export class PasswordService {
  private readonly dummyVerify = createDummyPasswordVerifier('raijin-dummy-password-for-timing');

  hash(password: string): Promise<string> {
    return hashPassword(password);
  }

  verify(passwordHash: string, password: string): Promise<boolean> {
    return verifyPassword(passwordHash, password);
  }

  /** Vérification factice (compte inexistant) : même coût qu'une vraie, contre l'énumération par le temps. */
  verifyDummy(password: string): Promise<void> {
    return this.dummyVerify(password);
  }

  /** Refuse un mot de passe identique à l'adresse e-mail ou à sa partie locale. */
  isRejected(password: string, email: string): boolean {
    const candidate = password.trim().toLowerCase();
    const address = email.trim().toLowerCase();
    return candidate === address || candidate === address.split('@')[0];
  }
}
