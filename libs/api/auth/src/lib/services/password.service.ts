import { Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';

/** Paramètres OWASP pour argon2id : m = 19 Mio, t = 2, p = 1. */
export const ARGON2_OPTIONS = { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Hachage et vérification des mots de passe (argon2id). */
@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** Vérification factice (compte inexistant) : même coût qu'une vraie, contre l'énumération par le temps. */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('raijin-dummy-password-for-timing');
    await this.verify(await this.dummyHash, password);
  }

  /** Refuse un mot de passe identique à l'adresse e-mail ou à sa partie locale. */
  isRejected(password: string, email: string): boolean {
    const candidate = password.trim().toLowerCase();
    const address = email.trim().toLowerCase();
    return candidate === address || candidate === address.split('@')[0];
  }
}
