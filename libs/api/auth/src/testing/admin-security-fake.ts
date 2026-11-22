import { testConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import { AdminSecurityService } from '../lib/admin-security/admin-security.service';
import { AuditService } from '../lib/audit/audit.service';
import { LoginAttemptsService, MemoryAttemptStore } from '../lib/services/login-attempts.service';

type Row = Record<string, unknown>;

/** Correspondance minimale des filtres Prisma utilisés par la 2FA admin (égalité, null, not, lt/gt, OR). */
export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Row[]).some((sub) => matches(row, sub));
    if (key === 'AND') return (condition as Row[]).every((sub) => matches(row, sub));
    const value = row[key];
    if (condition === null) return value === null || value === undefined;
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    if (typeof condition === 'object' && condition !== null) {
      const ops = condition as Row;
      if ('not' in ops) return ops['not'] === null ? value !== null && value !== undefined : value !== ops['not'];
      if ('lt' in ops) return value !== null && value !== undefined && (value as number | Date) < (ops['lt'] as number | Date);
      if ('lte' in ops) return value !== null && value !== undefined && (value as number | Date) <= (ops['lte'] as number | Date);
      if ('gt' in ops) return value !== null && value !== undefined && (value as number | Date) > (ops['gt'] as number | Date);
      if ('in' in ops) return (ops['in'] as unknown[]).includes(value);
      return true;
    }
    return value === condition;
  });
}

let sequence = 0;
const nextId = () => `00000000-0000-7000-8000-${String(++sequence).padStart(12, '0')}`;

function table(rows: Row[], defaults: () => Row = () => ({})) {
  return {
    rows,
    findUnique: jest.fn(async ({ where, select }: { where: Row; select?: Row }) => {
      const row = rows.find((candidate) => matches(candidate, where)) ?? null;
      if (!row || !select) return row;
      return row;
    }),
    findFirst: jest.fn(async ({ where }: { where?: Row }) => rows.find((candidate) => matches(candidate, where)) ?? null),
    findMany: jest.fn(async ({ where }: { where?: Row } = {}) => rows.filter((candidate) => matches(candidate, where))),
    count: jest.fn(async ({ where }: { where?: Row } = {}) => rows.filter((candidate) => matches(candidate, where)).length),
    create: jest.fn(async ({ data }: { data: Row }) => {
      const row = { id: nextId(), ...defaults(), ...data };
      rows.push(row);
      return row;
    }),
    createMany: jest.fn(async ({ data }: { data: Row[] }) => {
      for (const item of data) rows.push({ id: nextId(), ...defaults(), ...item });
      return { count: data.length };
    }),
    update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((candidate) => matches(candidate, where));
      if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hits = rows.filter((candidate) => matches(candidate, where));
      for (const row of hits) Object.assign(row, data);
      return { count: hits.length };
    }),
    deleteMany: jest.fn(async ({ where }: { where?: Row } = {}) => {
      const kept = rows.filter((candidate) => !matches(candidate, where));
      const count = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return { count };
    }),
  };
}

/** Base en mémoire : utilisateurs, sessions, secrets TOTP, codes de secours, journal d'audit. */
export function createAdminSecurityDb() {
  const db = {
    user: table([]),
    session: table([], () => ({ adminVerifiedAt: null, adminLastSeenAt: null, revokedAt: null })),
    totpSecret: table([], () => ({ enabledAt: null, lastUsedStep: null })),
    adminRecoveryCode: table([], () => ({ usedAt: null })),
    auditLog: table([], () => ({ createdAt: new Date() })),
    $transaction: jest.fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>(),
  };
  db.$transaction.mockImplementation(async (fn) => fn(db));
  return db;
}

export type AdminSecurityDb = ReturnType<typeof createAdminSecurityDb>;

/** Service 2FA sur la base en mémoire (clé TOTP fixe, compteur d'échecs en mémoire). */
export function createAdminSecurityKit(env: Record<string, string> = {}) {
  const db = createAdminSecurityDb();
  const config = testConfig({ TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), ...env });
  const prisma = db as unknown as PrismaService;
  const audit = new AuditService(prisma, config);
  const attempts = new LoginAttemptsService(config, new MemoryAttemptStore());
  const service = new AdminSecurityService(prisma, audit, attempts, config);
  return { db, config, audit, attempts, service };
}
