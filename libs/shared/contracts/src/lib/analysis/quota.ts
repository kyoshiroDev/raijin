import { z } from 'zod';
import { planSchema } from '../auth/user';

/** Types de quota (colonne `UsageCounter.kind`). */
export const QUOTA_KINDS = ['analysis', 'wallet_scan'] as const;
export const quotaKindSchema = z.enum(QUOTA_KINDS);
export type QuotaKind = z.infer<typeof quotaKindSchema>;

/** Sujet du quota : visiteur anonyme (compté par `ipHash`) ou utilisateur connecté. */
export const quotaSubjectSchema = z.enum(['anonymous', 'user']);
export type QuotaSubject = z.infer<typeof quotaSubjectSchema>;

/**
 * Quota restant, toujours calculé par l'API depuis la base (jamais par le front).
 * `limit` et `remaining` valent `null` pour un quota illimité. Remise à zéro à minuit UTC.
 */
export const quotaInfoSchema = z.object({
  kind: quotaKindSchema,
  subject: quotaSubjectSchema,
  plan: planSchema.nullable(),
  limit: z.number().int().positive().nullable(),
  used: z.number().int().min(0),
  remaining: z.number().int().min(0).nullable(),
  resetsAt: z.iso.datetime(),
});
export type QuotaInfo = z.infer<typeof quotaInfoSchema>;
