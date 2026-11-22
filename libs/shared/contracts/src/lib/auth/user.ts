import { z } from 'zod';

/** Plan de l'utilisateur (mêmes valeurs que l'enum Prisma `Plan`). */
export const planSchema = z.enum(['FREE', 'PRO']);
export type Plan = z.infer<typeof planSchema>;

export const PLAN_LABELS: Readonly<Record<Plan, string>> = {
  FREE: 'Gratuit',
  PRO: 'Pro',
};

/** Rôle (mêmes valeurs que l'enum Prisma `Role`). */
export const roleSchema = z.enum(['USER', 'ADMIN']);
export type Role = z.infer<typeof roleSchema>;

/**
 * État de l'essai Pro de 7 jours (« reverse trial », phase 6), calculé par l'API :
 * - `none` : jamais commencé (e-mail non vérifié) ;
 * - `active` : en cours (`endsAt` dans le futur) ;
 * - `ended` : terminé (converti ou repassé en Gratuit) ;
 * - `ineligible` : refusé par l'anti-abus (compte créé directement en Gratuit, message neutre).
 */
export const trialStatusSchema = z.enum(['none', 'active', 'ended', 'ineligible']);
export type TrialStatus = z.infer<typeof trialStatusSchema>;

export const trialStateSchema = z.object({
  status: trialStatusSchema,
  startedAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
});
export type TrialState = z.infer<typeof trialStateSchema>;

/**
 * Profil renvoyé au front (GET /api/v1/users/me, réponses de session). Jamais de hash,
 * d'identifiant Stripe, d'empreinte ni de champ d'attribution.
 */
export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  emailVerified: z.boolean(),
  /** Plan effectif (PRO pendant l'essai actif). */
  plan: planSchema,
  role: roleSchema,
  trial: trialStateSchema,
  createdAt: z.iso.datetime(),
});
export type PublicUser = z.infer<typeof publicUserSchema>;
