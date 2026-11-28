import * as z from '../zod';
import { TRIAL_REFUSAL_REASONS } from '../billing/events';

/**
 * Tableau de conversion des essais (phase 6, réservé au rôle ADMIN ; l'espace admin complet arrive en 6 bis).
 * Route : `GET admin/trial-conversion` → `TrialConversionReport` (403 `FORBIDDEN` sans le rôle ADMIN).
 * Taux = convertis / (convertis + expirés) : les essais encore actifs ne comptent pas.
 */
export const TRIAL_CONVERSION_MAX_WEEKS = 26;

const countSchema = z.number().int().min(0);

export const trialCohortSchema = z.object({
  /** Lundi (UTC) de la semaine de début d'essai. */
  weekStart: z.iso.date(),
  started: countSchema,
  active: countSchema,
  converted: countSchema,
  expired: countSchema,
  /** `null` si aucun essai terminé dans la cohorte. Entre 0 et 1. */
  conversionRate: z.number().min(0).max(1).nullable(),
});
export type TrialCohort = z.infer<typeof trialCohortSchema>;

export const trialConversionReportSchema = z.object({
  generatedAt: z.iso.datetime(),
  totals: z.object({
    started: countSchema,
    active: countSchema,
    converted: countSchema,
    expired: countSchema,
    conversionRate: z.number().min(0).max(1).nullable(),
  }),
  /** Refus de l'anti-abus par motif (jamais affiché à l'utilisateur concerné). */
  refusals: z.record(z.enum(TRIAL_REFUSAL_REASONS), countSchema),
  /** Semaines les plus récentes d'abord. */
  cohorts: z.array(trialCohortSchema).max(TRIAL_CONVERSION_MAX_WEEKS),
});
export type TrialConversionReport = z.infer<typeof trialConversionReportSchema>;
