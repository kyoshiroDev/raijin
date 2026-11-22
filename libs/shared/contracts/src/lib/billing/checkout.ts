import * as z from '../zod';
import { billingIntervalSchema } from './plans';

/**
 * Checkout hébergé et portail client (session, CSRF, throttler par utilisateur) :
 * - `POST billing/checkout-sessions` (`CheckoutSessionRequest`) → `BillingRedirect` ;
 * - `POST billing/portal-sessions` → `BillingRedirect` ;
 * - `POST billing/webhook` : Stripe uniquement (signature `Stripe-Signature`, corps brut, sans CSRF ni session).
 * Le front n'envoie que la périodicité : prix, montant, client et URLs de retour sont décidés par l'API.
 */
export const checkoutSessionRequestSchema = z
  .object({ interval: billingIntervalSchema })
  .strict();
export type CheckoutSessionRequest = z.infer<
  typeof checkoutSessionRequestSchema
>;

/** URL de redirection (Checkout, portail, ou page de simulation locale). */
export const billingRedirectSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2048),
});
export type BillingRedirect = z.infer<typeof billingRedirectSchema>;

/** Hôtes Stripe vers lesquels le front accepte de rediriger (en plus de sa propre origine en simulation). */
export const BILLING_REDIRECT_HOSTS = [
  'checkout.stripe.com',
  'billing.stripe.com',
] as const;

/**
 * Vrai si `url` est une redirection de paiement acceptable : https vers un hôte Stripe exact, ou même
 * origine que l'app (pages de simulation). Le front refuse toute autre URL (redirection ouverte).
 */
export function isAllowedBillingRedirect(
  url: string,
  appOrigin: string,
): boolean {
  const target = originOf(url);
  const app = originOf(appOrigin);
  if (!target || !app) return false;
  if (target.scheme === app.scheme && target.authority === app.authority)
    return true;
  return (
    target.scheme === 'https' &&
    (BILLING_REDIRECT_HOSTS as readonly string[]).includes(target.authority)
  );
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  http: ':80',
  https: ':443',
};

/** Schéma et autorité (hôte[:port] sans port par défaut) en minuscules ; `null` si non http(s) ou avec `user@`. */
function originOf(value: string): { scheme: string; authority: string } | null {
  const match = /^(https?):\/\/([^/?#\\]+)(?:[/?#]|$)/i.exec(value.trim());
  const scheme = match?.[1]?.toLowerCase();
  let authority = match?.[2]?.toLowerCase();
  if (!scheme || !authority || authority.includes('@')) return null;
  const defaultPort = DEFAULT_PORTS[scheme];
  if (defaultPort && authority.endsWith(defaultPort))
    authority = authority.slice(0, -defaultPort.length);
  return { scheme, authority };
}

/**
 * Pages de l'app utilisées comme retours fixes (l'API construit `${APP_URL}${chemin}`, jamais depuis la requête).
 * Succès : `?session_id={CHECKOUT_SESSION_ID}` (affichage seulement : le plan vient du webhook, le front relit
 * `GET billing/subscription`). Annulation : `?checkout=annule`.
 */
export const BILLING_RETURN_PATHS = {
  subscription: '/abonnement',
  checkoutSuccess: '/abonnement/succes',
  /** Faux Checkout (`BILLING_PROVIDER=fake`). */
  simulatedCheckout: '/abonnement/simulation',
  /** Faux portail (`BILLING_PROVIDER=fake`). */
  simulatedPortal: '/abonnement/simulation-portail',
} as const;
export const CHECKOUT_SESSION_ID_PARAM = 'session_id';
export const CHECKOUT_CANCELED_PARAM = 'checkout';
export const CHECKOUT_CANCELED_VALUE = 'annule';

/** Identifiant d'une session du faux Checkout. */
export const fakeCheckoutSessionIdSchema = z
  .string()
  .regex(/^cs_fake_[A-Za-z0-9]{16,64}$/);

/**
 * Simulation (`BILLING_PROVIDER=fake`, 404 sinon et toujours en production ; session + CSRF) :
 * - `POST billing/simulation/checkout` (`FakeCheckoutCompleteRequest`) : l'API signe localement l'événement
 *   `checkout.session.completed` (ou `invoice.payment_failed`) et le traite par le même chemin que le webhook ;
 * - `POST billing/simulation/portal` (`FakePortalActionRequest`) : `customer.subscription.updated` / `deleted`.
 */
export const fakeCheckoutCompleteRequestSchema = z
  .object({
    sessionId: fakeCheckoutSessionIdSchema,
    outcome: z.enum(['paid', 'payment_failed']),
  })
  .strict();
export type FakeCheckoutCompleteRequest = z.infer<
  typeof fakeCheckoutCompleteRequestSchema
>;

export const fakePortalActionRequestSchema = z
  .object({
    action: z.enum([
      'cancel_at_period_end',
      'resume',
      'cancel_now',
      'switch_interval',
    ]),
  })
  .strict();
export type FakePortalActionRequest = z.infer<
  typeof fakePortalActionRequestSchema
>;
