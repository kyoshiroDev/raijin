import type { PrismaService, User } from '@raijin/api-prisma';

/** Utilisateur de test complet (valeurs par défaut du schéma). */
export function userFixture(overrides: Partial<User> = {}): User {
  const now = new Date('2026-11-22T10:00:00Z');
  return {
    id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    email: 'jean.dupont@exemple.fr',
    emailNormalized: 'jean.dupont@exemple.fr',
    passwordHash: '$argon2id$factice',
    emailVerifiedAt: null,
    passwordChangedAt: null,
    termsAcceptedAt: now,
    plan: 'FREE',
    role: 'USER',
    trialStatus: 'NONE',
    trialStartedAt: null,
    trialEndsAt: null,
    stripeCustomerId: null,
    lastLoginAt: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    referrer: null,
    landingPath: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function model() {
  return {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
}

/** Double de PrismaService : chaque méthode est un `jest.fn()`. `$transaction` exécute le tableau. */
export function createPrismaMock() {
  const mock = {
    user: model(),
    session: model(),
    refreshToken: model(),
    authToken: model(),
    auditLog: model(),
    productEvent: model(),
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  return { mock, prisma: mock as unknown as PrismaService };
}
