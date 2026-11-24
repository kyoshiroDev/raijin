import { BENCH_RECOVERY_CODE_COUNT } from '@raijin/bench-contracts';
import {
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchTotp,
  otpauthUri,
  recoveryCodeKey,
} from '@raijin/server-security';

/** Contexte HKDF propre au banc : une même clé maîtresse ne donne pas la clé des codes de Raijin. */
export const BENCH_RECOVERY_KEY_INFO = 'raijin-bench-recovery-codes';
/** Émetteur affiché par l'application d'authentification. */
export const BENCH_TOTP_ISSUER = 'Raijin-banc-de-test';

/** Opérations TOTP / codes de secours du banc (briques `@raijin/server-security`, clé propre au banc). */
export class BenchSecondFactor {
  private readonly recoveryKey: Buffer;

  constructor(private readonly totpKey: Buffer) {
    this.recoveryKey = recoveryCodeKey(totpKey, BENCH_RECOVERY_KEY_INFO);
  }

  /** Pas TOTP validé (fenêtre ±1, rejeu refusé) ou `null` ; secret illisible → `null`. */
  matchTotp(ownerId: string, secretEncrypted: string, code: string, now: Date, lastUsedStep: number | null): number | null {
    try {
      return matchTotp(decryptTotpSecret(this.totpKey, ownerId, secretEncrypted), code, now, lastUsedStep);
    } catch {
      return null;
    }
  }

  hashRecoveryCode(ownerId: string, code: string): string {
    return hashRecoveryCode(this.recoveryKey, ownerId, code);
  }

  /** Nouveau secret (chiffré pour la base, base32 et URI pour l'affichage unique) et nouveaux codes de secours. */
  enroll(ownerId: string, account: string): { secretEncrypted: string; secretBase32: string; uri: string; recoveryCodes: string[]; recoveryHashes: string[] } {
    const secret = generateTotpSecret();
    const secretBase32 = base32Encode(secret);
    const recoveryCodes = generateRecoveryCodes(BENCH_RECOVERY_CODE_COUNT);
    return {
      secretEncrypted: encryptTotpSecret(this.totpKey, ownerId, secret),
      secretBase32,
      uri: otpauthUri(BENCH_TOTP_ISSUER, account, secretBase32),
      recoveryCodes,
      recoveryHashes: recoveryCodes.map((code) => this.hashRecoveryCode(ownerId, code)),
    };
  }
}
