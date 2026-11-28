import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { BenchPrismaService } from '@raijin/bench-prisma';
import { FakePushSender, PushSender } from '@raijin/server-push';
import { base32Decode, hashPassword, totpAt } from '@raijin/server-security';
import { BenchAuthStore } from '../lib/auth/auth.store';
import { BenchSecondFactor } from '../lib/auth/second-factor';
import { BenchCoreModule } from '../lib/bench-core.module';
import { loadBenchConfig, type BenchConfig } from '../lib/config/bench-config';
import { setupBenchApp } from '../lib/http/setup-bench-app';
import { JobRunStore } from '../lib/jobs/job-runs.store';
import { BenchMailSender, type BenchMailMessage, type MailResult } from '../lib/mode/bench-notifier';
import { MemoryBenchAuthStore } from './memory-auth-store';
import { MemoryJobRunStore } from './memory-job-run-store';

export const OWNER_EMAIL = 'proprietaire@banc.test';
export const OWNER_PASSWORD = 'une phrase de passe du banc';
export const ORIGIN = 'http://localhost:4300';

/** Horloge réglable des tests. */
export class TestClock {
  constructor(public current = new Date('2026-11-24T10:00:00.000Z')) {}
  readonly now = (): Date => new Date(this.current.getTime());
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SpyMailSender extends BenchMailSender {
  readonly configured = true;
  readonly sent: BenchMailMessage[] = [];
  async send(message: BenchMailMessage): Promise<MailResult> {
    this.sent.push(message);
    return { status: 'sent' };
  }
}

export function testConfig(env: Record<string, string> = {}): BenchConfig {
  return loadBenchConfig({ NODE_ENV: 'test', BENCH_OWNER_EMAIL: OWNER_EMAIL, ...env });
}

/** Faux client Prisma : seules les méthodes utilisées par le socle (santé, taille). */
export const fakePrisma = {
  healthy: true,
  sizeBytes: 100 * 1024 ** 2,
  async isHealthy(): Promise<boolean> {
    return this.healthy;
  },
  async databaseSizeBytes(): Promise<number> {
    if (!this.healthy) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    return this.sizeBytes;
  },
  async $connect(): Promise<void> {
    return undefined;
  },
  async $disconnect(): Promise<void> {
    return undefined;
  },
};

export interface TestBench {
  readonly app: INestApplication;
  readonly config: BenchConfig;
  readonly clock: TestClock;
  readonly store: MemoryBenchAuthStore;
  readonly runs: MemoryJobRunStore;
  readonly push: FakePushSender;
  readonly mail: SpyMailSender;
  /** Clé TOTP base32 du propriétaire (posé et activé). */
  readonly totpSecret: string;
  readonly recoveryCodes: readonly string[];
  totp(offsetSteps?: number): string;
}

/** Propriétaire prêt à se connecter (mot de passe + TOTP activé + codes de secours). */
export async function seedOwner(store: MemoryBenchAuthStore, config: BenchConfig, at: Date): Promise<{ secret: string; recoveryCodes: string[] }> {
  const ownerId = await store.saveOwnerPassword(config.ownerEmail, await hashPassword(OWNER_PASSWORD), at);
  const enrollment = new BenchSecondFactor(config.auth.totpKey).enroll(ownerId, config.ownerEmail);
  await store.replaceSecondFactor(ownerId, enrollment.secretEncrypted, enrollment.recoveryHashes, at);
  if (store.totp) store.totp.enabledAt = at;
  return { secret: enrollment.secretBase32, recoveryCodes: enrollment.recoveryCodes };
}

/** API du banc complète en mémoire (aucune base, aucun Redis, aucun réseau). */
export async function createTestBench(env: Record<string, string> = {}): Promise<TestBench> {
  const config = testConfig(env);
  const clock = new TestClock();
  const store = new MemoryBenchAuthStore();
  const runs = new MemoryJobRunStore();
  const push = new FakePushSender('BPublicKeyDeTest');
  const mail = new SpyMailSender();
  const { secret, recoveryCodes } = await seedOwner(store, config, clock.now());
  fakePrisma.healthy = true;
  const moduleRef = await Test.createTestingModule({ imports: [BenchCoreModule.forRoot({ config, version: 'test', clock: clock.now })] })
    .overrideProvider(BenchPrismaService)
    .useValue(fakePrisma)
    .overrideProvider(BenchAuthStore)
    .useValue(store)
    .overrideProvider(JobRunStore)
    .useValue(runs)
    .overrideProvider(PushSender)
    .useValue(push)
    .overrideProvider(BenchMailSender)
    .useValue(mail)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  setupBenchApp(app, config);
  await app.init();
  return {
    app,
    config,
    clock,
    store,
    runs,
    push,
    mail,
    totpSecret: secret,
    recoveryCodes,
    totp: (offsetSteps = 0) => totpAt(base32Decode(secret), new Date(clock.now().getTime() + offsetSteps * 30_000)),
  };
}

/** Cookies `nom=valeur` d'une réponse supertest. */
export function cookiesOf(headers: Record<string, unknown>): Record<string, string> {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const out: Record<string, string> = {};
  for (const line of list) {
    const [pair] = line.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair && index > 0) out[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return out;
}
