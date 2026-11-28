import { Injectable } from '@nestjs/common';
import { randomToken, sha256 } from '@raijin/api-core';
import { PrismaService, type AuthToken, type AuthTokenType } from '@raijin/api-prisma';

/**
 * Jetons d'e-mail (vérification, réinitialisation, lien magique) : opaques, hachés en base,
 * à usage unique, avec TTL. En émettre un nouveau invalide les précédents du même type.
 */
@Injectable()
export class AuthTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(
    userId: string,
    type: AuthTokenType,
    ttlMs: number,
    redirectPath: string | null = null,
  ): Promise<string> {
    const token = randomToken(32);
    await this.prisma.$transaction([
      this.prisma.authToken.deleteMany({ where: { userId, type, usedAt: null } }),
      this.prisma.authToken.create({
        data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs), redirectPath },
      }),
    ]);
    return token;
  }

  /** Consomme un jeton (atomique) ; `null` s'il est inconnu, d'un autre type, expiré ou déjà utilisé. */
  async consume(token: string, type: AuthTokenType): Promise<AuthToken | null> {
    const now = new Date();
    const record = await this.prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.type !== type || record.usedAt || record.expiresAt <= now) return null;
    const claimed = await this.prisma.authToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    return claimed.count === 1 ? { ...record, usedAt: now } : null;
  }

  /** Invalide les jetons non utilisés d'un utilisateur (types donnés). */
  async revokeUnused(userId: string, types: readonly AuthTokenType[]): Promise<void> {
    await this.prisma.authToken.deleteMany({ where: { userId, type: { in: [...types] }, usedAt: null } });
  }
}
