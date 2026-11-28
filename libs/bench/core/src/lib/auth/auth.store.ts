import { Injectable } from '@nestjs/common';
import { BenchPrismaService } from '@raijin/bench-prisma';

/** Propriétaire unique du banc (`bench_owner`) et son second facteur. */
export interface OwnerRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly totp: { readonly secretEncrypted: string; readonly enabled: boolean; readonly lastUsedStep: number | null } | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerEmail: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface NewSession {
  readonly ownerId: string;
  readonly tokenHash: string;
  readonly userAgent: string | null;
  readonly ipHash: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** Raisons admises par la contrainte `bench_sessions_revoked_reason_check`. */
export type SessionRevokeReason = 'logout' | 'logout_others' | 'password_change' | 'totp_reset' | 'idle' | 'expired';

/**
 * Persistance de l'authentification du banc. Implémentations : `PrismaBenchAuthStore` (base `raijin_bench`),
 * `MemoryBenchAuthStore` (tests). Les jetons ne sont jamais stockés en clair (HMAC).
 */
export abstract class BenchAuthStore {
  abstract findOwner(): Promise<OwnerRecord | null>;
  /** Marque le pas TOTP utilisé ; faux si un pas ≥ a déjà servi (rejeu, course entre deux requêtes). */
  abstract consumeTotpStep(ownerId: string, step: number, at: Date): Promise<boolean>;
  /** Consomme un code de secours non utilisé ; faux sinon. */
  abstract consumeRecoveryCode(ownerId: string, codeHash: string, at: Date): Promise<boolean>;
  abstract createSession(session: NewSession): Promise<string>;
  abstract findSession(tokenHash: string): Promise<SessionRecord | null>;
  abstract touchSession(id: string, at: Date): Promise<void>;
  abstract revokeSession(id: string, reason: SessionRevokeReason, at: Date): Promise<void>;
  abstract revokeAllSessions(ownerId: string, reason: SessionRevokeReason, at: Date): Promise<number>;
  /** Crée la ligne `bench_owner` (ou met à jour l'e-mail d'une ligne importée) et pose le mot de passe. */
  abstract saveOwnerPassword(email: string, passwordHash: string, at: Date): Promise<string>;
  /** Remplace le secret TOTP (en attente de confirmation) et tous les codes de secours. */
  abstract replaceSecondFactor(ownerId: string, secretEncrypted: string, recoveryCodeHashes: readonly string[], at: Date): Promise<void>;
  /** Active le TOTP après saisie d'un code valide (pas consommé). */
  abstract enableTotp(ownerId: string, step: number, at: Date): Promise<void>;
}

/** Implémentation Prisma (`bench_owner`, `bench_owner_totp`, `bench_recovery_codes`, `bench_sessions`). */
@Injectable()
export class PrismaBenchAuthStore extends BenchAuthStore {
  constructor(private readonly prisma: BenchPrismaService) {
    super();
  }

  async findOwner(): Promise<OwnerRecord | null> {
    const owner = await this.prisma.bench_owner.findUnique({ where: { singleton: true }, include: { bench_owner_totp: true } });
    if (!owner) return null;
    const totp = owner.bench_owner_totp;
    return {
      id: owner.id,
      email: owner.email,
      passwordHash: owner.password_hash,
      totp: totp ? { secretEncrypted: totp.secret_encrypted, enabled: totp.enabled_at !== null, lastUsedStep: totp.last_used_step } : null,
    };
  }

  async consumeTotpStep(ownerId: string, step: number, at: Date): Promise<boolean> {
    const result = await this.prisma.bench_owner_totp.updateMany({
      where: { owner_id: ownerId, enabled_at: { not: null }, OR: [{ last_used_step: null }, { last_used_step: { lt: step } }] },
      data: { last_used_step: step, updated_at: at },
    });
    return result.count === 1;
  }

  async consumeRecoveryCode(ownerId: string, codeHash: string, at: Date): Promise<boolean> {
    const result = await this.prisma.bench_recovery_codes.updateMany({ where: { owner_id: ownerId, code_hash: codeHash, used_at: null }, data: { used_at: at } });
    return result.count === 1;
  }

  async createSession(session: NewSession): Promise<string> {
    const row = await this.prisma.bench_sessions.create({
      data: {
        owner_id: session.ownerId,
        token_hash: session.tokenHash,
        user_agent: session.userAgent,
        ip_hash: session.ipHash,
        created_at: session.createdAt,
        last_seen_at: session.createdAt,
        expires_at: session.expiresAt,
      },
      select: { id: true },
    });
    return row.id;
  }

  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    const row = await this.prisma.bench_sessions.findUnique({ where: { token_hash: tokenHash }, include: { bench_owner: { select: { email: true } } } });
    if (!row) return null;
    return {
      id: row.id,
      ownerId: row.owner_id,
      ownerEmail: row.bench_owner.email,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  async touchSession(id: string, at: Date): Promise<void> {
    await this.prisma.bench_sessions.updateMany({ where: { id, revoked_at: null }, data: { last_seen_at: at } });
  }

  async revokeSession(id: string, reason: SessionRevokeReason, at: Date): Promise<void> {
    await this.prisma.bench_sessions.updateMany({ where: { id, revoked_at: null }, data: { revoked_at: at, revoked_reason: reason } });
  }

  async revokeAllSessions(ownerId: string, reason: SessionRevokeReason, at: Date): Promise<number> {
    const result = await this.prisma.bench_sessions.updateMany({ where: { owner_id: ownerId, revoked_at: null }, data: { revoked_at: at, revoked_reason: reason } });
    return result.count;
  }

  async saveOwnerPassword(email: string, passwordHash: string, at: Date): Promise<string> {
    const row = await this.prisma.bench_owner.upsert({
      where: { singleton: true },
      create: { singleton: true, email, password_hash: passwordHash, password_changed_at: at, created_at: at, updated_at: at },
      update: { email, password_hash: passwordHash, password_changed_at: at, updated_at: at },
      select: { id: true },
    });
    return row.id;
  }

  async replaceSecondFactor(ownerId: string, secretEncrypted: string, recoveryCodeHashes: readonly string[], at: Date): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.bench_recovery_codes.deleteMany({ where: { owner_id: ownerId } }),
      this.prisma.bench_owner_totp.upsert({
        where: { owner_id: ownerId },
        create: { owner_id: ownerId, secret_encrypted: secretEncrypted, enabled_at: null, last_used_step: null, created_at: at, updated_at: at },
        update: { secret_encrypted: secretEncrypted, enabled_at: null, last_used_step: null, updated_at: at },
      }),
      this.prisma.bench_recovery_codes.createMany({ data: recoveryCodeHashes.map((code_hash) => ({ owner_id: ownerId, code_hash, created_at: at })) }),
    ]);
  }

  async enableTotp(ownerId: string, step: number, at: Date): Promise<void> {
    await this.prisma.bench_owner_totp.update({ where: { owner_id: ownerId }, data: { enabled_at: at, last_used_step: step, updated_at: at } });
  }
}
