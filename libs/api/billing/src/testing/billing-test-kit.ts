import { join } from 'node:path';
import { testConfig, type AppConfig } from '@raijin/api-core';
import type { Mailer, MailMessage } from '@raijin/api-notifications';
import type { PrismaService } from '@raijin/api-prisma';
import type { StripeWebhookEventType } from '@raijin/shared-contracts';
import { loadBillingConfig, type BillingConfig } from '../lib/config/billing-config';
import { BillingService } from '../lib/domain/billing.service';
import { BillingWebhookService } from '../lib/domain/billing-webhook.service';
import type { BillingClock, PlanLimitHooks } from '../lib/domain/billing-ports';
import { BillingMailService } from '../lib/mail/billing-mail.service';
import { DefaultTrialConversion } from '../lib/domain/trial-conversion';
import type { BillingProvider } from '../lib/provider/billing-provider';
import { FakeBillingProvider, signEventJson, type SignedFakeEvent } from '../lib/provider/fake-billing.provider';
import { BillingSimulationService } from '../lib/simulation/billing-simulation.service';
import { MemoryBillingPrisma } from './memory-billing-prisma';
import { buildFixtureEvent, type WebhookFixtureOverrides } from './webhook-fixtures';

export const NOW = new Date('2026-11-22T12:00:00.000Z');
export const FIXTURES_DIR = join(__dirname, 'fixtures');

/** Expéditeur d'e-mails en mémoire. */
export class RecordingMailer {
  readonly sent: MailMessage[] = [];
  fail = false;

  async send(message: MailMessage): Promise<void> {
    if (this.fail) throw Object.assign(new Error('smtp'), { code: 'ECONNREFUSED' });
    this.sent.push(message);
  }
}

export interface BillingKit {
  readonly app: AppConfig;
  readonly config: BillingConfig;
  readonly prisma: MemoryBillingPrisma;
  readonly fake: FakeBillingProvider;
  readonly mailer: RecordingMailer;
  readonly hooks: PlanLimitHooks & { enforcePlanLimit: jest.Mock; resumePlanLimited: jest.Mock };
  readonly clock: BillingClock & { current: Date };
  readonly webhook: BillingWebhookService;
  readonly billing: BillingService;
  readonly simulation: BillingSimulationService;
  /** Fixture personnalisée et signée avec le secret de la configuration. */
  fixture(name: StripeWebhookEventType, overrides?: WebhookFixtureOverrides, timestamp?: number): SignedFakeEvent;
}

export function billingKit(options: { env?: Record<string, string>; provider?: BillingProvider; appEnv?: Record<string, string> } = {}): BillingKit {
  const app = testConfig(options.appEnv);
  const config = loadBillingConfig({ STRIPE_WEBHOOK_SECRET: 'whsec_testtesttesttesttesttest', ...options.env }, app);
  const clock = { current: NOW, now() { return this.current; } };
  const fake = new FakeBillingProvider(config, app.appUrl, () => clock.current);
  const provider = options.provider ?? fake;
  const prisma = new MemoryBillingPrisma();
  const mailer = new RecordingMailer();
  const mail = new BillingMailService(mailer as unknown as Mailer, app);
  const hooks = { enforcePlanLimit: jest.fn(async () => 2), resumePlanLimited: jest.fn(async () => 1) };
  const db = prisma as unknown as PrismaService;
  const webhook = new BillingWebhookService(db, provider, mail, hooks, clock, new DefaultTrialConversion(app), config);
  const billing = new BillingService(db, provider, clock, config, app);
  const simulation = new BillingSimulationService(provider, webhook, db, app);
  return {
    app,
    config,
    prisma,
    fake,
    mailer,
    hooks,
    clock,
    webhook,
    billing,
    simulation,
    fixture: (name, overrides = {}, timestamp) =>
      signEventJson(config.webhookSecret ?? '', buildFixtureEvent(name, overrides, { dir: FIXTURES_DIR, now: clock.current, defaultPriceId: config.prices.monthlyId ?? undefined }), timestamp),
  };
}
