import { z } from 'zod';
import { externalLabelSchema, relativePathSchema } from './common';

/** URL de provenance : http(s) uniquement, bornée. Les autres schémas sont refusés. */
const referrerSchema = z
  .string()
  .trim()
  .max(2048)
  .pipe(z.url({ protocol: /^https?$/, message: 'Provenance invalide.' }));

/**
 * Attribution capturée à la première visite (landing ou app) et envoyée à l'inscription.
 * Tous les champs sont facultatifs ; les clés inconnues sont ignorées. Données hostiles :
 * l'API les stocke telles quelles (bornées) et le front les échappe à l'affichage (admin).
 */
export const signupAttributionSchema = z.object({
  utmSource: externalLabelSchema.optional(),
  utmMedium: externalLabelSchema.optional(),
  utmCampaign: externalLabelSchema.optional(),
  referrer: referrerSchema.optional(),
  landingPath: relativePathSchema.optional(),
});
export type SignupAttribution = z.infer<typeof signupAttributionSchema>;
