import { z } from 'zod';

/** Codes d'erreur standard de l'API (`/api/v1`). */
export const apiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** Format d'erreur unique renvoyé par l'API, sans stack trace en production. */
export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
