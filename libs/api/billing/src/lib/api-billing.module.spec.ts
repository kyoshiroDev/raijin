import { testConfig } from '@raijin/api-core';
import type { WatchesService } from '@raijin/api-alerts';
import { createBillingProvider, createPlanLimitHooks } from './api-billing.module';
import { loadBillingConfig } from './config/billing-config';
import { FakeBillingProvider } from './provider/fake-billing.provider';
import { StripeBillingProvider } from './provider/stripe-billing.provider';

describe('ApiBillingModule', () => {
  it('choisit la simulation en dev et Stripe sinon (jamais la simulation en production)', () => {
    const dev = testConfig();
    expect(createBillingProvider(loadBillingConfig({}, dev), dev)).toBeInstanceOf(FakeBillingProvider);
    expect(createBillingProvider(loadBillingConfig({ BILLING_PROVIDER: 'stripe' }, dev), dev)).toBeInstanceOf(StripeBillingProvider);
    const fakeConfig = loadBillingConfig({}, dev);
    expect(createBillingProvider(fakeConfig, { ...dev, isProduction: true })).toBeInstanceOf(StripeBillingProvider);
  });

  it('branche les suivis : mise en pause et reprise', async () => {
    const watches = { enforcePlanLimit: jest.fn(async () => 3), resumePlanLimited: jest.fn(async () => 2) };
    const hooks = createPlanLimitHooks(watches as unknown as WatchesService);
    await expect(hooks.enforcePlanLimit('u')).resolves.toBe(3);
    await expect(hooks.resumePlanLimited('u')).resolves.toBe(2);
    expect(watches.resumePlanLimited).toHaveBeenCalledWith('u');
  });
});
