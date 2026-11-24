import * as z from '../zod';
import { EMAIL_MAX_LENGTH, emailSchema, externalLabelSchema } from '../auth/common';
import { planSchema, roleSchema, trialStatusSchema } from '../auth/user';
import { planSourceSchema, subscriptionSchema } from '../billing/subscription';
import { pageQueryShape, pageResponseSchema } from '../pagination';
import { trialDetailsSchema } from '../trial/trial';
import { auditLogEntrySchema } from './audit';
import { countSchema, externalText } from './common';
import { totpCodeSchema } from './security';

/**
 * Utilisateurs (écran 7) : recherche, liste filtrable, fiche, actions auditées. **Pas d'usurpation de compte.**
 * Routes (session admin vérifiée) :
 * - `GET admin/users?q=…&plan=…&cursor=…` (`AdminUserListQuery`) → `AdminUserPage` (une recherche `q` est auditée)
 * - `GET admin/users/:id` → `AdminUserDetail` (consultation auditée ; 404 si inconnu)
 * - `POST admin/users/:id/actions` (`AdminUserActionRequest`, CSRF) → `AdminUserActionResult`
 */

export const ADMIN_USER_STATUSES = ['active', 'unverified', 'suspended'] as const;
export const adminUserStatusSchema = z.enum(ADMIN_USER_STATUSES);
export type AdminUserStatus = z.infer<typeof adminUserStatusSchema>;

export const ADMIN_USER_STATUS_LABELS: Readonly<Record<AdminUserStatus, string>> = {
  active: 'Actif',
  unverified: 'E-mail non vérifié',
  suspended: 'Suspendu',
};

/** Longueur minimale d'une recherche par e-mail (fragment, insensible à la casse). */
export const ADMIN_USER_SEARCH_MIN_LENGTH = 3;

export const adminUserListQuerySchema = z
  .object({
    q: z.string().trim().toLowerCase().min(ADMIN_USER_SEARCH_MIN_LENGTH).max(EMAIL_MAX_LENGTH).optional(),
    plan: planSchema.optional(),
    trialStatus: trialStatusSchema.optional(),
    status: adminUserStatusSchema.optional(),
    /** Valeur exacte de `utmSource` ; `(direct)` = sans source. */
    source: externalLabelSchema.optional(),
    signupFrom: z.iso.date().optional(),
    signupTo: z.iso.date().optional(),
    ...pageQueryShape,
  })
  .refine((value) => !value.signupFrom || !value.signupTo || value.signupFrom <= value.signupTo, {
    message: 'Période d’inscription invalide.',
    path: ['signupTo'],
  });
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

export const adminUserSummarySchema = z.object({
  id: z.uuid(),
  email: z.email(),
  /** Plan effectif (Pro pendant l'essai, l'abonnement ou le mois offert). */
  plan: planSchema,
  planSource: planSourceSchema,
  role: roleSchema,
  status: adminUserStatusSchema,
  trialStatus: trialStatusSchema,
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
  utmSource: externalText(200).nullable(),
});
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const adminUserPageSchema = pageResponseSchema(adminUserSummarySchema).extend({
  /** Nombre total de comptes correspondant aux filtres. */
  total: countSchema,
});
export type AdminUserPage = z.infer<typeof adminUserPageSchema>;

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export const ADMIN_USER_ACTION_TYPES = [
  'extend_trial',
  'grant_pro_month',
  'suspend',
  'reactivate',
  'resend_verification',
  'delete',
] as const;
export const adminUserActionTypeSchema = z.enum(ADMIN_USER_ACTION_TYPES);
export type AdminUserActionType = z.infer<typeof adminUserActionTypeSchema>;

export const ADMIN_USER_ACTION_LABELS: Readonly<Record<AdminUserActionType, string>> = {
  extend_trial: 'Prolonger l’essai',
  grant_pro_month: 'Offrir un mois de Pro',
  suspend: 'Suspendre le compte',
  reactivate: 'Réactiver le compte',
  resend_verification: 'Renvoyer l’e-mail de vérification',
  delete: 'Supprimer le compte (RGPD)',
};

/** Actions dont la confirmation exige de recopier l'e-mail du compte (et, pour `delete`, un code TOTP frais). */
export const ADMIN_DESTRUCTIVE_ACTIONS: readonly AdminUserActionType[] = ['suspend', 'delete'];

/** Prolongation d'essai : 1 à 14 jours par action. */
export const ADMIN_TRIAL_EXTENSION_MAX_DAYS = 14;
/** Mois de Pro offert = 30 jours, cumulables jusqu'à 365 jours d'avance au plus. */
export const ADMIN_GIFT_DAYS = 30;
export const ADMIN_GIFT_MAX_DAYS_AHEAD = 365;

const reasonSchema = externalText(500)
  .transform((value) => value.trim())
  .pipe(z.string().min(3, { message: 'Indique un motif (3 caractères au moins).' }));

export const adminUserActionRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('extend_trial'), days: z.number().int().min(1).max(ADMIN_TRIAL_EXTENSION_MAX_DAYS), reason: reasonSchema }).strict(),
  z.object({ type: z.literal('grant_pro_month'), reason: reasonSchema }).strict(),
  z.object({ type: z.literal('suspend'), reason: reasonSchema, confirmEmail: emailSchema }).strict(),
  z.object({ type: z.literal('reactivate'), reason: reasonSchema }).strict(),
  z.object({ type: z.literal('resend_verification') }).strict(),
  z.object({ type: z.literal('delete'), reason: reasonSchema, confirmEmail: emailSchema, totpCode: totpCodeSchema }).strict(),
]);
export type AdminUserActionRequest = z.infer<typeof adminUserActionRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Fiche
// ---------------------------------------------------------------------------------------------

/** Lien vers le client dans le dashboard Stripe (construit par l'API, hôte exact, mode test ou réel). */
export const STRIPE_DASHBOARD_CUSTOMER_URL = /^https:\/\/dashboard\.stripe\.com\/(test\/)?customers\/cus_[A-Za-z0-9]{1,64}$/;

/**
 * Lien du dashboard Stripe d'un client selon le **mode de facturation** (clé `sk_live_` → réel, sinon `/test/`), et
 * non selon `NODE_ENV` ; `null` sans client Stripe.
 */
export function stripeDashboardCustomerUrl(customerId: string | null, livemode: boolean): string | null {
  if (customerId === null) return null;
  const url = `https://dashboard.stripe.com/${livemode ? '' : 'test/'}customers/${customerId}`;
  return STRIPE_DASHBOARD_CUSTOMER_URL.test(url) ? url : null;
}

export const ADMIN_USER_AUDIT_MAX = 20;

export const adminUserDetailSchema = adminUserSummarySchema.extend({
  emailVerified: z.boolean(),
  trial: trialDetailsSchema,
  subscription: subscriptionSchema.nullable(),
  stripeDashboardUrl: z.string().regex(STRIPE_DASHBOARD_CUSTOMER_URL).nullable(),
  /** Fin du Pro offert par l'admin ; `null` si aucun en cours. */
  giftEndsAt: z.iso.datetime().nullable(),
  suspendedAt: z.iso.datetime().nullable(),
  attribution: z.object({
    utmSource: externalText(200).nullable(),
    utmMedium: externalText(200).nullable(),
    utmCampaign: externalText(200).nullable(),
    referrer: externalText(2048).nullable(),
    landingPath: externalText(512).nullable(),
  }),
  usage: z.object({
    analysesToday: countSchema,
    analyses30d: countSchema,
    walletScans30d: countSchema,
    alerts30d: countSchema,
  }),
  watches: z.object({ active: countSchema, paused: countSchema }),
  pushSubscriptions: countSchema,
  /** 20 dernières entrées du journal visant ce compte. */
  audit: z.array(auditLogEntrySchema).max(ADMIN_USER_AUDIT_MAX),
  /** Actions possibles dans l'état actuel (aucune sur un compte ADMIN ni sur soi-même). */
  availableActions: z.array(adminUserActionTypeSchema),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

export const adminUserActionResultSchema = z.object({
  type: adminUserActionTypeSchema,
  auditLogId: z.uuid(),
  /** Fiche relue après l'action ; `null` après une suppression. */
  user: adminUserDetailSchema.nullable(),
});
export type AdminUserActionResult = z.infer<typeof adminUserActionResultSchema>;
