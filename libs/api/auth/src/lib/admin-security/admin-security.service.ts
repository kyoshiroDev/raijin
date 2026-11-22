import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, ApiException, type AppConfig } from '@raijin/api-core';
import { PrismaService, type Prisma } from '@raijin/api-prisma';
import {
  ADMIN_ENROLLMENT_TTL_SECONDS,
  type AdminEnrollmentConfirmResponse,
  type AdminEnrollmentStart,
  type AdminRecoveryCodes,
  type AdminSecondFactor,
  type AdminSecurityStatus,
} from '@raijin/shared-contracts';
import { renderSVG } from 'uqr';
import { AuditService } from '../audit/audit.service';
import type { ClientInfo } from '../services/client-info';
import { LoginAttemptsService } from '../services/login-attempts.service';
import { adminSessionDeadlines, adminSessionState } from './admin-session';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes';
import { decryptTotpSecret, encryptTotpSecret, recoveryCodeKey } from './secret-box';
import { base32Encode, generateTotpSecret, matchTotp, otpauthUri } from './totp';

/** Préfixe du compteur Redis des codes 2FA faux (par compte). */
export const ADMIN_2FA_FAIL_PREFIX = 'rj:admin-2fa-fail:';

/**
 * 2FA TOTP et session admin (docs/ARCHITECTURE.md §14.2, §14.3). Le secret clair n'existe qu'en mémoire le temps
 * d'un calcul ; il n'est renvoyé qu'au début de l'enrôlement. Chaque succès et chaque échec sont audités.
 */
@Injectable()
export class AdminSecurityService {
  private readonly recoveryKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly attempts: LoginAttemptsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.recoveryKey = recoveryCodeKey(config.admin.totpEncryptionKey);
  }

  // ---------------------------------------------------------------------------------------------
  // État
  // ---------------------------------------------------------------------------------------------

  async status(userId: string, sessionId: string, now: Date = new Date()): Promise<AdminSecurityStatus> {
    const [secret, session, remaining] = await Promise.all([
      this.prisma.totpSecret.findUnique({ where: { userId }, select: { enabledAt: true } }),
      this.prisma.session.findUnique({ where: { id: sessionId }, select: { adminVerifiedAt: true, adminLastSeenAt: true } }),
      this.prisma.adminRecoveryCode.count({ where: { userId, usedAt: null } }),
    ]);
    const enrolled = !!secret?.enabledAt;
    const columns = session ?? { adminVerifiedAt: null, adminLastSeenAt: null };
    const verified = enrolled && adminSessionState(columns, this.config.admin, now) === 'active';
    const deadlines = verified ? adminSessionDeadlines(columns, this.config.admin, now) : { idleExpiresAt: null, absoluteExpiresAt: null };
    return {
      enrolled,
      verified,
      idleExpiresAt: deadlines.idleExpiresAt?.toISOString() ?? null,
      absoluteExpiresAt: deadlines.absoluteExpiresAt?.toISOString() ?? null,
      idleTimeoutSeconds: Math.round(this.config.admin.sessionIdleMs / 1000),
      recoveryCodesRemaining: enrolled ? remaining : null,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Enrôlement
  // ---------------------------------------------------------------------------------------------

  /** `POST admin/security/enrollment` : nouveau secret en attente (remplace un enrôlement inachevé). */
  async startEnrollment(userId: string, now: Date = new Date()): Promise<AdminEnrollmentStart> {
    const [user, existing] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
      this.prisma.totpSecret.findUnique({ where: { userId }, select: { enabledAt: true } }),
    ]);
    if (!user) throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
    if (existing?.enabledAt) throw ApiException.admin('ADMIN_2FA_ALREADY_ENROLLED', HttpStatus.CONFLICT);
    const secret = generateTotpSecret();
    const secretEncrypted = encryptTotpSecret(this.config.admin.totpEncryptionKey, userId, secret);
    // Course avec une confirmation : la condition `enabledAt: null` empêche d'écraser une 2FA tout juste activée.
    const replaced = await this.prisma.totpSecret.updateMany({
      where: { userId, enabledAt: null },
      data: { secretEncrypted, lastUsedStep: null, updatedAt: now },
    });
    if (replaced.count === 0) {
      try {
        await this.prisma.totpSecret.create({ data: { userId, secretEncrypted, createdAt: now, updatedAt: now } });
      } catch {
        throw ApiException.admin('ADMIN_2FA_ALREADY_ENROLLED', HttpStatus.CONFLICT);
      }
    }
    const base32 = base32Encode(secret);
    secret.fill(0);
    const uri = otpauthUri(this.config.admin.totpIssuer, user.email, base32);
    const svg = renderSVG(uri, { border: 2 });
    return {
      otpauthUri: uri,
      secret: base32,
      qrCodeDataUri: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
      expiresAt: new Date(now.getTime() + ADMIN_ENROLLMENT_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /** `POST admin/security/enrollment/confirm` : active la 2FA, génère les codes de secours, vérifie la session. */
  async confirmEnrollment(userId: string, sessionId: string, code: string, client: ClientInfo | null, now: Date = new Date()): Promise<AdminEnrollmentConfirmResponse> {
    const pending = await this.prisma.totpSecret.findUnique({ where: { userId }, select: { secretEncrypted: true, enabledAt: true, updatedAt: true } });
    if (pending?.enabledAt) throw ApiException.admin('ADMIN_2FA_ALREADY_ENROLLED', HttpStatus.CONFLICT);
    if (!pending || now.getTime() - pending.updatedAt.getTime() > ADMIN_ENROLLMENT_TTL_SECONDS * 1000) {
      throw ApiException.admin('ADMIN_2FA_ENROLLMENT_EXPIRED', HttpStatus.CONFLICT);
    }
    await this.assertNotLocked(userId);
    let step: number | null;
    try {
      step = this.match(userId, pending.secretEncrypted, code, now, null);
    } catch {
      // Clé éphémère changée (redémarrage en développement) : recommencer l'enrôlement.
      throw ApiException.admin('ADMIN_2FA_ENROLLMENT_EXPIRED', HttpStatus.CONFLICT);
    }
    if (step === null) return this.fail(userId, client, 'totp');
    const codes = generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      const enabled = await tx.totpSecret.updateMany({
        where: { userId, enabledAt: null, secretEncrypted: pending.secretEncrypted },
        data: { enabledAt: now, lastUsedStep: step },
      });
      if (enabled.count !== 1) throw ApiException.admin('ADMIN_2FA_ENROLLMENT_EXPIRED', HttpStatus.CONFLICT);
      await this.replaceRecoveryCodes(tx, userId, codes, now);
      await tx.session.update({ where: { id: sessionId }, data: { adminVerifiedAt: now, adminLastSeenAt: now } });
      await this.audit.recordInTx(tx, { action: 'admin.2fa_enrolled', actorKind: 'admin', actorId: userId, userId, client });
    });
    await this.attempts.counters.reset(this.failKey(userId));
    return {
      status: await this.status(userId, sessionId, now),
      recoveryCodes: { codes, generatedAt: now.toISOString() },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Vérification de la session
  // ---------------------------------------------------------------------------------------------

  /** `POST admin/security/verify` : code TOTP ou code de secours (usage unique) → session admin vérifiée. */
  async verify(userId: string, sessionId: string, factor: AdminSecondFactor, client: ClientInfo | null, now: Date = new Date()): Promise<AdminSecurityStatus> {
    await this.assertNotLocked(userId);
    if (factor.method === 'totp') {
      await this.consumeTotp(userId, factor.code, client, now);
    } else {
      await this.consumeRecoveryCode(userId, factor.code, client, now);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.session.update({ where: { id: sessionId }, data: { adminVerifiedAt: now, adminLastSeenAt: now } });
      await this.audit.recordInTx(tx, {
        action: factor.method === 'totp' ? 'admin.2fa_verified' : 'admin.recovery_code_used',
        actorKind: 'admin',
        actorId: userId,
        userId,
        client,
      });
    });
    await this.attempts.counters.reset(this.failKey(userId));
    return this.status(userId, sessionId, now);
  }

  /**
   * Code TOTP frais exigé par une action sensible (régénération des codes, suppression d'un compte) : compte
   * dans l'anti-force brute, rejeu refusé ; 400 `ADMIN_2FA_INVALID` / 429 `ADMIN_2FA_LOCKED`.
   */
  async verifyFreshTotp(userId: string, code: string, client: ClientInfo | null, now: Date = new Date()): Promise<void> {
    await this.assertNotLocked(userId);
    await this.consumeTotp(userId, code, client, now);
    await this.attempts.counters.reset(this.failKey(userId));
  }

  /** `POST admin/security/recovery-codes` : nouveaux codes (les anciens sont invalidés), code TOTP frais exigé. */
  async regenerateRecoveryCodes(userId: string, code: string, client: ClientInfo | null, now: Date = new Date()): Promise<AdminRecoveryCodes> {
    await this.verifyFreshTotp(userId, code, client, now);
    const codes = generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await this.replaceRecoveryCodes(tx, userId, codes, now);
      await this.audit.recordInTx(tx, { action: 'admin.recovery_codes_regenerated', actorKind: 'admin', actorId: userId, userId, client });
    });
    return { codes, generatedAt: now.toISOString() };
  }

  /** `POST admin/security/end` : quitte l'espace admin ; la session de l'app reste ouverte. */
  async end(userId: string, sessionId: string, client: ClientInfo | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ended = await tx.session.updateMany({
        where: { id: sessionId, userId, adminVerifiedAt: { not: null } },
        data: { adminVerifiedAt: null, adminLastSeenAt: null },
      });
      if (ended.count > 0) await this.audit.recordInTx(tx, { action: 'admin.session_ended', actorKind: 'admin', actorId: userId, userId, client });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Outils
  // ---------------------------------------------------------------------------------------------

  private failKey(userId: string): string {
    return `${ADMIN_2FA_FAIL_PREFIX}${userId}`;
  }

  private async assertNotLocked(userId: string): Promise<void> {
    const failures = await this.attempts.counters.get(this.failKey(userId));
    if (failures >= this.config.admin.totpMaxAttempts) throw ApiException.admin('ADMIN_2FA_LOCKED', HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Échec : compteur incrémenté, audité, 400 ou 429 au seuil. */
  private async fail(userId: string, client: ClientInfo | null, method: 'totp' | 'recovery'): Promise<never> {
    const failures = await this.attempts.counters.increment(this.failKey(userId), this.config.admin.totpLockoutMs);
    const locked = failures >= this.config.admin.totpMaxAttempts;
    await this.audit.recordStrict({
      action: 'admin.2fa_failed',
      actorKind: 'admin',
      actorId: userId,
      userId,
      client,
      metadata: { details: { method, locked } },
    });
    throw locked
      ? ApiException.admin('ADMIN_2FA_LOCKED', HttpStatus.TOO_MANY_REQUESTS)
      : ApiException.admin('ADMIN_2FA_INVALID', HttpStatus.BAD_REQUEST);
  }

  private match(userId: string, secretEncrypted: string, code: string, now: Date, lastUsedStep: number | null): number | null {
    const secret = decryptTotpSecret(this.config.admin.totpEncryptionKey, userId, secretEncrypted);
    try {
      return matchTotp(secret, code, now, lastUsedStep);
    } finally {
      secret.fill(0);
    }
  }

  /** Vérifie un code TOTP de la 2FA activée et consomme son pas (rejeu impossible, même en concurrence). */
  private async consumeTotp(userId: string, code: string, client: ClientInfo | null, now: Date): Promise<void> {
    const secret = await this.prisma.totpSecret.findUnique({ where: { userId }, select: { secretEncrypted: true, enabledAt: true, lastUsedStep: true } });
    if (!secret?.enabledAt) throw ApiException.admin('ADMIN_2FA_ENROLLMENT_REQUIRED', HttpStatus.FORBIDDEN);
    let step: number | null;
    try {
      step = this.match(userId, secret.secretEncrypted, code, now, secret.lastUsedStep);
    } catch {
      // Clé changée ou secret illisible : réinitialisation par la CLI (admin-reset-2fa).
      step = null;
    }
    if (step === null) return this.fail(userId, client, 'totp');
    const consumed = await this.prisma.totpSecret.updateMany({
      where: { userId, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
      data: { lastUsedStep: step },
    });
    if (consumed.count !== 1) return this.fail(userId, client, 'totp');
  }

  private async consumeRecoveryCode(userId: string, code: string, client: ClientInfo | null, now: Date): Promise<void> {
    const enrolled = await this.prisma.totpSecret.findUnique({ where: { userId }, select: { enabledAt: true } });
    if (!enrolled?.enabledAt) throw ApiException.admin('ADMIN_2FA_ENROLLMENT_REQUIRED', HttpStatus.FORBIDDEN);
    const codeHash = hashRecoveryCode(this.recoveryKey, userId, code);
    const used = await this.prisma.adminRecoveryCode.updateMany({ where: { userId, codeHash, usedAt: null }, data: { usedAt: now } });
    if (used.count !== 1) return this.fail(userId, client, 'recovery');
  }

  private async replaceRecoveryCodes(tx: Prisma.TransactionClient, userId: string, codes: readonly string[], now: Date): Promise<void> {
    await tx.adminRecoveryCode.deleteMany({ where: { userId } });
    await tx.adminRecoveryCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(this.recoveryKey, userId, code), createdAt: now })),
    });
  }
}
