import { randomBytes } from 'node:crypto';
import { ConfigError, type AppConfig } from '@raijin/api-core';
import * as z from 'zod';

/**
 * Configuration de l'abonnement (bloc « Stripe » de docs/ENV.md, docs/ARCHITECTURE.md §13.8), lue une fois au
 * démarrage. Aucune valeur secrète n'apparaît dans les messages (nom de la variable seulement).
 */
export interface BillingConfig {
  /** `fake` : simulation locale (dev/test, refusée en production) ; `stripe` : SDK officiel. */
  readonly provider: 'fake' | 'stripe';
  /** Clé secrète Stripe valide (`sk_test_…` / `sk_live_…` / `rk_…`), sinon `null` (paiement indisponible). */
  readonly secretKey: string | null;
  /** Secret de signature des webhooks ; en simulation sans valeur : secret éphémère généré au démarrage. */
  readonly webhookSecret: string | null;
  /** Mode réel (clé `sk_live_`) : `event.livemode` doit correspondre. */
  readonly livemode: boolean;
  readonly prices: {
    readonly monthlyId: string | null;
    readonly yearlyId: string | null;
    readonly monthlyCents: number;
    readonly yearlyCents: number;
    /** ISO 4217 en majuscules. */
    readonly currency: string;
  };
  readonly portalConfigurationId: string | null;
  /** Sessions Checkout / portail par minute et par utilisateur. */
  readonly perMinute: number;
  /** Tolérance de la signature (s). */
  readonly webhookToleranceS: number;
}

export const BILLING_CONFIG = Symbol('BILLING_CONFIG');

/** Valeurs factices de `.env.example` : traitées comme absentes. */
const PLACEHOLDER = /changeme|factice/i;
const SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=_-]{16,}$/;
const PRICE_ID = /^price_[A-Za-z0-9]{6,}$/;
const PORTAL_CONFIGURATION_ID = /^bpc_[A-Za-z0-9]{6,}$/;

const optional = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

const billingEnvSchema = z.object({
  BILLING_PROVIDER: z.enum(['fake', 'stripe']).optional(),
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  STRIPE_PRICE_PRO_MONTHLY: optional,
  STRIPE_PRICE_PRO_YEARLY: optional,
  STRIPE_PORTAL_CONFIGURATION_ID: optional,
  PRO_PRICE_MONTHLY_CENTS: z.coerce.number().int().min(50).max(1_000_000).default(990),
  PRO_PRICE_YEARLY_CENTS: z.coerce.number().int().min(50).max(10_000_000).default(9900),
  BILLING_CURRENCY: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, { message: 'code ISO 4217 attendu (ex. EUR)' })
    .default('EUR')
    .transform((value) => value.toUpperCase()),
  RATE_LIMIT_BILLING_PER_MINUTE: z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(1).max(600).optional()),
});

function real(value: string | undefined, pattern: RegExp): string | null {
  return value && !PLACEHOLDER.test(value) && pattern.test(value) ? value : null;
}

/**
 * Construit la configuration de l'abonnement.
 * - `BILLING_PROVIDER` : `fake` par défaut hors production, `stripe` en production ; `fake` en production → refus.
 * - Une clé `sk_live_` hors production → refus (mode test uniquement en développement).
 * - `stripe` sans clé, secret ou prix valides : l'API démarre en mode « paiement indisponible » (avertissement).
 */
export function loadBillingConfig(
  env: NodeJS.ProcessEnv,
  app: Pick<AppConfig, 'isProduction'>,
  warn: (message: string) => void = () => undefined,
): BillingConfig {
  const parsed = billingEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'} : ${issue.message}`));
  }
  const e = parsed.data;
  const problems: string[] = [];
  const provider = e.BILLING_PROVIDER ?? (app.isProduction ? 'stripe' : 'fake');
  if (provider === 'fake' && app.isProduction) problems.push('BILLING_PROVIDER : fake interdit en production (simulation)');

  const secretKey = real(e.STRIPE_SECRET_KEY, SECRET_KEY);
  const livemode = secretKey !== null && /^(sk|rk)_live_/.test(secretKey);
  if (livemode && !app.isProduction) problems.push('STRIPE_SECRET_KEY : clé live interdite hors production (mode test uniquement)');

  let webhookSecret = real(e.STRIPE_WEBHOOK_SECRET, WEBHOOK_SECRET);
  const monthlyId = real(e.STRIPE_PRICE_PRO_MONTHLY, PRICE_ID);
  const yearlyId = real(e.STRIPE_PRICE_PRO_YEARLY, PRICE_ID);
  if (monthlyId && monthlyId === yearlyId) problems.push('STRIPE_PRICE_PRO_MONTHLY / STRIPE_PRICE_PRO_YEARLY : deux prix distincts attendus');
  if (e.PRO_PRICE_YEARLY_CENTS <= e.PRO_PRICE_MONTHLY_CENTS) problems.push('PRO_PRICE_YEARLY_CENTS : doit dépasser PRO_PRICE_MONTHLY_CENTS');

  if (provider === 'fake') {
    if (!webhookSecret) {
      webhookSecret = `whsec_${randomBytes(24).toString('base64url')}`;
      warn('STRIPE_WEBHOOK_SECRET absente : secret éphémère généré pour signer les événements simulés (simulation seulement).');
    }
  } else {
    const missing = [
      !secretKey && 'STRIPE_SECRET_KEY',
      !webhookSecret && 'STRIPE_WEBHOOK_SECRET',
      !monthlyId && 'STRIPE_PRICE_PRO_MONTHLY',
      !yearlyId && 'STRIPE_PRICE_PRO_YEARLY',
    ].filter((name): name is string => typeof name === 'string');
    if (missing.length > 0) warn(`Stripe non configuré (${missing.join(', ')} absente ou factice) : paiement indisponible (503 BILLING_NOT_CONFIGURED).`);
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    provider,
    secretKey: provider === 'stripe' ? secretKey : null,
    webhookSecret,
    livemode: provider === 'stripe' && livemode,
    prices: Object.freeze({
      monthlyId: provider === 'fake' ? 'price_fake_monthly' : monthlyId,
      yearlyId: provider === 'fake' ? 'price_fake_yearly' : yearlyId,
      monthlyCents: e.PRO_PRICE_MONTHLY_CENTS,
      yearlyCents: e.PRO_PRICE_YEARLY_CENTS,
      currency: e.BILLING_CURRENCY,
    }),
    portalConfigurationId: real(e.STRIPE_PORTAL_CONFIGURATION_ID, PORTAL_CONFIGURATION_ID),
    perMinute: e.RATE_LIMIT_BILLING_PER_MINUTE ?? 10,
    webhookToleranceS: 300,
  });
}

/** Stripe utilisable : clé, secret et deux prix valides. */
export function stripeConfigured(config: BillingConfig): boolean {
  return config.provider === 'stripe' && !!config.secretKey && !!config.webhookSecret && !!config.prices.monthlyId && !!config.prices.yearlyId;
}
