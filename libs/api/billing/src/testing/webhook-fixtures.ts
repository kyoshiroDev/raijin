import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STRIPE_WEBHOOK_EVENT_TYPES, type StripeWebhookEventType, type SubscriptionStatus } from '@raijin/shared-contracts';
import * as z from 'zod';

/**
 * Fixtures des 5 événements Stripe traités (`fixtures/<type>.json`, format de la version d'API épinglée),
 * personnalisées puis **signées à la volée** (Jest, api-e2e via `POST internal/billing/webhook-fixtures/:name`).
 * Jetons remplacés : `evt_fixture_…`, `cus_fixture_0001`, `sub_fixture_0001`, `in_fixture_0001`,
 * `price_fixture_monthly`, userId `00000000-0000-7000-8000-000000000001`.
 */
export const FIXTURE_TOKENS = {
  customerId: 'cus_fixture_0001',
  subscriptionId: 'sub_fixture_0001',
  invoiceId: 'in_fixture_0001',
  priceId: 'price_fixture_monthly',
  userId: '00000000-0000-7000-8000-000000000001',
} as const;

/** Dossier des fixtures depuis la racine du dépôt (API lancée depuis la racine, comme les fixtures Solana). */
export const WEBHOOK_FIXTURES_DIR = join('libs', 'api', 'billing', 'src', 'testing', 'fixtures');

const idPattern = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_]{4,64}$`));

/** Personnalisation d'une fixture (corps de la route interne, tests). */
export const webhookFixtureOverridesSchema = z
  .object({
    eventId: idPattern('evt_').optional(),
    /** Horodatage Stripe de l'événement (ISO 8601). */
    created: z.iso.datetime().optional(),
    userId: z.uuid().optional(),
    customerId: idPattern('cus_').optional(),
    subscriptionId: idPattern('sub_').optional(),
    invoiceId: idPattern('in_').optional(),
    priceId: idPattern('price_').optional(),
    status: z.enum(['trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused']).optional(),
    cancelAtPeriodEnd: z.boolean().optional(),
    currentPeriodEnd: z.iso.datetime().optional(),
    amountCents: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict();
export type WebhookFixtureOverrides = z.infer<typeof webhookFixtureOverridesSchema>;

export function isFixtureName(name: string): name is StripeWebhookEventType {
  return (STRIPE_WEBHOOK_EVENT_TYPES as readonly string[]).includes(name);
}

type Json = Record<string, unknown>;

function replaceTokens(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceTokens(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTokens(item, replacements)]));
  }
  return value;
}

/**
 * Événement de fixture personnalisé (objet JSON, non signé). Fin de période par défaut : `now` + 30 jours
 * (abonnement en cours) ; identifiant d'événement par défaut : unique.
 */
export function buildFixtureEvent(
  name: StripeWebhookEventType,
  overrides: WebhookFixtureOverrides = {},
  options: { dir?: string; now?: Date; defaultPriceId?: string } = {},
): Json {
  const dir = options.dir ?? join(process.cwd(), WEBHOOK_FIXTURES_DIR);
  const raw = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Json;
  const now = options.now ?? new Date();
  const replacements = new Map<string, string>();
  const set = (token: string, value: string | undefined) => {
    if (value) replacements.set(token, value);
  };
  set(FIXTURE_TOKENS.customerId, overrides.customerId);
  set(FIXTURE_TOKENS.subscriptionId, overrides.subscriptionId);
  set(FIXTURE_TOKENS.invoiceId, overrides.invoiceId);
  set(FIXTURE_TOKENS.priceId, overrides.priceId ?? options.defaultPriceId);
  set(FIXTURE_TOKENS.userId, overrides.userId);
  const event = replaceTokens(raw, replacements) as Json;
  event['id'] = overrides.eventId ?? `evt_fixture_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  event['created'] = Math.floor((overrides.created ? Date.parse(overrides.created) : now.getTime()) / 1000);
  const object = (event['data'] as Json)['object'] as Json;
  if (object['object'] === 'subscription') {
    if (overrides.status) object['status'] = overrides.status satisfies SubscriptionStatus;
    if (overrides.cancelAtPeriodEnd !== undefined) object['cancel_at_period_end'] = overrides.cancelAtPeriodEnd;
    const periodEnd = Math.floor((overrides.currentPeriodEnd ? Date.parse(overrides.currentPeriodEnd) : now.getTime() + 30 * 86_400_000) / 1000);
    for (const item of ((object['items'] as Json)['data'] as Json[]) ?? []) item['current_period_end'] = periodEnd;
  }
  if (object['object'] === 'invoice' && overrides.amountCents !== undefined) {
    object['amount_due'] = overrides.amountCents;
    if (object['status'] === 'paid') object['amount_paid'] = overrides.amountCents;
  }
  return event;
}
