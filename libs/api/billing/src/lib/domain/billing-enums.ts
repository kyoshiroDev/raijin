import type { BillingInterval, SubscriptionStatus } from '@raijin/shared-contracts';

/** Enums Prisma (majuscules) ↔ contrats (minuscules, valeurs Stripe). */
export type PrismaSubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'INCOMPLETE' | 'INCOMPLETE_EXPIRED' | 'UNPAID' | 'PAUSED';
export type PrismaBillingInterval = 'MONTH' | 'YEAR';

export function toPrismaStatus(status: SubscriptionStatus): PrismaSubscriptionStatus {
  return status.toUpperCase() as PrismaSubscriptionStatus;
}

export function fromPrismaStatus(status: PrismaSubscriptionStatus): SubscriptionStatus {
  return status.toLowerCase() as SubscriptionStatus;
}

export function toPrismaInterval(interval: BillingInterval): PrismaBillingInterval {
  return interval === 'year' ? 'YEAR' : 'MONTH';
}

export function fromPrismaInterval(interval: PrismaBillingInterval): BillingInterval {
  return interval === 'YEAR' ? 'year' : 'month';
}
