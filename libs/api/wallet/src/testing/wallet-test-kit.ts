import {
  AnalysisClock,
  FactsCollector,
  MemoryKeyValueStore,
  UpstreamUnavailableError,
  type CollectedFacts,
  type QuotaPolicy,
  type QuotaReservation,
  type QuotaService,
} from '@raijin/api-analysis';
import { ApiException, testConfig, type AppConfig } from '@raijin/api-core';
import type { PrismaService } from '@raijin/api-prisma';
import type { QuotaInfo, RiskFacts } from '@raijin/shared-contracts';
import { WalletAccessService } from '../lib/access/wallet-access.service';
import type { WalletDataSource } from '../lib/ports/wallet-data-source';
import { DefaultQuickRiskEngine } from '../lib/scan/quick-verdict';
import { WalletRepository } from '../lib/scan/wallet.repository';
import { WalletScanService } from '../lib/scan/wallet-scan.service';
import { WalletVerdictsService } from '../lib/scan/wallet-verdicts.service';
import { FixtureWalletDataSource } from '../lib/fixtures/fixture-wallets';

export const NOW = new Date('2026-11-22T12:00:00.000Z');
export const USER_ID = '0195a0c4-0000-7000-8000-000000000001';

/** Faits d'un token sain (autorités révoquées, liquidité verrouillée, holders répartis). */
export function healthyFacts(mint: string, overrides: Partial<RiskFacts> = {}): RiskFacts {
  return {
    version: 1,
    mint,
    observedAt: NOW.toISOString(),
    mintAccount: {
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      tokenProgram: 'spl-token',
      extensions: { transferFeeBps: null, permanentDelegate: false, transferHook: false, nonTransferable: false },
    },
    metadata: { mutable: false },
    liquidity: {
      usd: 1_000_000,
      samples: [{ source: 'dexscreener', usd: 1_000_000 }],
      lpBurnedOrLockedPct: 100,
      lpRemoved: false,
    },
    holders: { top10Pct: 20, maxSingleHolderPct: 5, excludedAccounts: 2 },
    sellSimulation: null,
    age: { tokenCreatedAt: '2023-01-01T00:00:00.000Z', poolCreatedAt: '2023-01-02T00:00:00.000Z' },
    creator: null,
    rugcheck: null,
    ...overrides,
  };
}

/** Faits d'un token Danger (autorité de mint active). */
export function dangerFacts(mint: string): RiskFacts {
  const base = healthyFacts(mint);
  const account = base.mintAccount;
  return account ? { ...base, mintAccount: { ...account, mintAuthorityActive: true } } : base;
}

export type FactsOutcome = RiskFacts | 'upstream' | 'not_found';

/** Collecteur de faits `light` scripté par mint (inconnu : panne). */
export class ScriptedFacts extends FactsCollector {
  readonly calls: string[] = [];

  constructor(private readonly outcomes: Record<string, FactsOutcome>) {
    super();
  }

  async collectFacts(mint: string): Promise<CollectedFacts | null> {
    this.calls.push(mint);
    const outcome = this.outcomes[mint] ?? 'upstream';
    if (outcome === 'upstream') throw new UpstreamUnavailableError();
    if (outcome === 'not_found') return null;
    return { facts: outcome, token: null, sources: [] };
  }

  async resolveMint(): Promise<string | null> {
    return null;
  }
}

/** Quota en mémoire, mêmes règles visibles que `QuotaService` (limite, déduplication, remboursement). */
export class MemoryQuota {
  readonly counts = new Map<string, number>();
  readonly seen = new Set<string>();
  failures = 0;
  refunds = 0;

  async reserve(policy: QuotaPolicy, key: string): Promise<QuotaReservation> {
    const day = NOW.toISOString().slice(0, 10);
    const seenKey = `${policy.kind}:${policy.userId}:${key}`;
    const used = this.counts.get(policy.kind) ?? 0;
    if (this.seen.has(seenKey)) return { policy, day, counted: false, used, seenKey: null };
    if (policy.limit !== null && used >= policy.limit) throw new ApiException('QUOTA_EXCEEDED', 429);
    this.seen.add(seenKey);
    this.counts.set(policy.kind, used + 1);
    return { policy, day, counted: true, used: used + 1, seenKey };
  }

  async settleFailure(reservation: QuotaReservation): Promise<void> {
    this.failures += 1;
    if (!reservation.counted) return;
    this.refunds += 1;
    if (reservation.seenKey) this.seen.delete(reservation.seenKey);
    this.counts.set(reservation.policy.kind, Math.max(0, (this.counts.get(reservation.policy.kind) ?? 1) - 1));
  }

  async info(policy: QuotaPolicy, used?: number): Promise<QuotaInfo> {
    const count = used ?? this.counts.get(policy.kind) ?? 0;
    return {
      kind: policy.kind,
      subject: policy.subject,
      plan: policy.plan,
      limit: policy.limit,
      used: count,
      remaining: policy.limit === null ? null : Math.max(0, policy.limit - count),
      resetsAt: '2026-11-23T00:00:00.000Z',
    };
  }
}

export interface UserRow {
  plan: 'FREE' | 'PRO';
  trialStatus: string;
  trialEndsAt: Date | null;
  emailVerifiedAt: Date | null;
}

export const PRO_USER: UserRow = { plan: 'PRO', trialStatus: 'NONE', trialEndsAt: null, emailVerifiedAt: NOW };
export const TRIAL_USER: UserRow = { plan: 'FREE', trialStatus: 'ACTIVE', trialEndsAt: new Date(NOW.getTime() + 86_400_000), emailVerifiedAt: NOW };
export const FREE_USER: UserRow = { plan: 'FREE', trialStatus: 'NONE', trialEndsAt: null, emailVerifiedAt: NOW };

export function fakePrisma(user: UserRow | null) {
  return {
    user: { findUnique: jest.fn(async () => user) },
    tokenAnalysis: { findMany: jest.fn(async () => [] as unknown[]) },
    productEvent: { create: jest.fn(async () => ({})) },
  };
}

export class FixedClock extends AnalysisClock {
  now(): Date {
    return NOW;
  }
}

export interface KitOptions {
  readonly user?: UserRow | null;
  readonly facts?: Record<string, FactsOutcome>;
  readonly source?: WalletDataSource;
  readonly env?: Record<string, string>;
}

/** Services du scan assemblés sur des doublures (aucune base, aucun Redis, aucun réseau). */
export function walletKit(options: KitOptions = {}) {
  const config: AppConfig = testConfig(options.env);
  const prisma = fakePrisma(options.user === undefined ? PRO_USER : options.user);
  const store = new MemoryKeyValueStore();
  const quota = new MemoryQuota();
  const clock = new FixedClock();
  const facts = new ScriptedFacts(options.facts ?? {});
  const source = options.source ?? new FixtureWalletDataSource(facts);
  const engine = new DefaultQuickRiskEngine();
  const repository = new WalletRepository(prisma as unknown as PrismaService);
  const access = new WalletAccessService(prisma as unknown as PrismaService, quota as unknown as QuotaService, clock, config);
  const verdicts = new WalletVerdictsService(source, engine, store, repository, clock, config);
  const scan = new WalletScanService(access, source, verdicts, engine, store, repository, clock, config);
  scan.waitPollMs = 5;
  return { config, prisma, store, quota, clock, facts, source, engine, repository, access, verdicts, scan };
}
