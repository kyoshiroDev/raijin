import { randomUUID } from 'node:crypto';
import { BenchAuthStore, type NewSession, type OwnerRecord, type SessionRecord, type SessionRevokeReason } from '../lib/auth/auth.store';

interface MemorySession extends NewSession {
  id: string;
  lastSeenAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokeReason | null;
}

/** Stockage d'auth en mémoire (tests) : mêmes règles que les contraintes SQL utiles (12 h max, raisons). */
export class MemoryBenchAuthStore extends BenchAuthStore {
  owner: { id: string; email: string; passwordHash: string | null } | null = null;
  totp: { secretEncrypted: string; enabledAt: Date | null; lastUsedStep: number | null } | null = null;
  recovery = new Map<string, Date | null>();
  readonly sessions = new Map<string, MemorySession>();
  /** Date de la dernière écriture (équivalent de `updated_at`). */
  updatedAt: Date | null = null;

  async findOwner(): Promise<OwnerRecord | null> {
    if (!this.owner) return null;
    return {
      ...this.owner,
      totp: this.totp ? { secretEncrypted: this.totp.secretEncrypted, enabled: this.totp.enabledAt !== null, lastUsedStep: this.totp.lastUsedStep } : null,
    };
  }

  async consumeTotpStep(_ownerId: string, step: number, at?: Date): Promise<boolean> {
    if (!this.totp?.enabledAt) return false;
    if (this.totp.lastUsedStep !== null && this.totp.lastUsedStep >= step) return false;
    this.totp.lastUsedStep = step;
    this.updatedAt = at ?? null;
    return true;
  }

  async consumeRecoveryCode(_ownerId: string, codeHash: string, at: Date): Promise<boolean> {
    if (!this.recovery.has(codeHash) || this.recovery.get(codeHash) !== null) return false;
    this.recovery.set(codeHash, at);
    return true;
  }

  async createSession(session: NewSession): Promise<string> {
    if (session.expiresAt.getTime() > session.createdAt.getTime() + 12 * 3600_000) throw new Error('bench_sessions_expiry_check');
    const id = randomUUID();
    this.sessions.set(session.tokenHash, { ...session, id, lastSeenAt: session.createdAt, revokedAt: null, revokedReason: null });
    return id;
  }

  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    const row = this.sessions.get(tokenHash);
    if (!row || !this.owner) return null;
    return { id: row.id, ownerId: row.ownerId, ownerEmail: this.owner.email, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
  }

  private byId(id: string): MemorySession | undefined {
    return [...this.sessions.values()].find((row) => row.id === id);
  }

  async touchSession(id: string, at: Date): Promise<void> {
    const row = this.byId(id);
    if (row && !row.revokedAt) row.lastSeenAt = at;
  }

  async revokeSession(id: string, reason: SessionRevokeReason, at: Date): Promise<void> {
    const row = this.byId(id);
    if (row && !row.revokedAt) {
      row.revokedAt = at;
      row.revokedReason = reason;
    }
  }

  async revokeAllSessions(_ownerId: string, reason: SessionRevokeReason, at: Date): Promise<number> {
    let count = 0;
    for (const row of this.sessions.values()) {
      if (!row.revokedAt) {
        row.revokedAt = at;
        row.revokedReason = reason;
        count += 1;
      }
    }
    return count;
  }

  async saveOwnerPassword(email: string, passwordHash: string, at?: Date): Promise<string> {
    this.updatedAt = at ?? null;
    this.owner = { id: this.owner?.id ?? randomUUID(), email, passwordHash };
    return this.owner.id;
  }

  async replaceSecondFactor(_ownerId: string, secretEncrypted: string, recoveryCodeHashes: readonly string[], at?: Date): Promise<void> {
    this.updatedAt = at ?? null;
    this.totp = { secretEncrypted, enabledAt: null, lastUsedStep: null };
    this.recovery = new Map(recoveryCodeHashes.map((hash) => [hash, null]));
  }

  async enableTotp(_ownerId: string, step: number, at: Date): Promise<void> {
    if (!this.totp) throw new Error('no totp');
    this.totp.enabledAt = at;
    this.totp.lastUsedStep = step;
  }
}
