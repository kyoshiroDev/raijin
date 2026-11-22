import { z } from 'zod';
import { mintAddressSchema } from '../address';
import { checkStatusSchema, verdictSchema } from '../verdict';
import { ANALYSIS_CHECK_IDS, analysisCheckIdSchema } from './checks';
import { quotaInfoSchema } from './quota';
import { riskReasonCodeSchema } from './risk';
import { dataSourceRefSchema } from './sources';
import { tokenMetadataSchema } from './token';

/** Mention obligatoire sous chaque résultat (PROMPT.md §0, §8). */
export const ANALYSIS_DISCLAIMER =
  'Information en lecture seule, pas un conseil en investissement.';

/** Rappel affiché avec le verdict Sain (PROMPT.md §4.1). */
export const SAFE_VERDICT_REMINDER = 'Aucun signal détecté ne veut pas dire sans risque.';

/** Unités des valeurs chiffrées (formatage côté front avec `@raijin/shared-util`). */
export const CHECK_METRIC_UNITS = ['usd', 'percent', 'count', 'days', 'hours', 'sol', 'address'] as const;
export const checkMetricUnitSchema = z.enum(CHECK_METRIC_UNITS);
export type CheckMetricUnit = z.infer<typeof checkMetricUnitSchema>;

/** Valeur chiffrée d'un contrôle (ex. liquidité 12 400 USD, LP brûlée 100 %). */
export const checkMetricSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().min(1).max(60),
  value: z.union([z.number().finite(), z.boolean(), z.string().max(120), z.null()]),
  unit: checkMetricUnitSchema.nullable(),
});
export type CheckMetric = z.infer<typeof checkMetricSchema>;

/** Un contrôle tel qu'affiché : statut, phrase simple, valeurs, sources citées. */
export const analysisCheckSchema = z.object({
  id: analysisCheckIdSchema,
  status: checkStatusSchema,
  /** Explication en une phrase simple (texte rédigé par Raijin, pas par une source externe). */
  summary: z.string().min(1).max(200),
  metrics: z.array(checkMetricSchema).max(8),
  sources: z.array(dataSourceRefSchema).min(1).max(4),
  reasonCodes: z.array(riskReasonCodeSchema).max(8),
});
export type AnalysisCheck = z.infer<typeof analysisCheckSchema>;

/** Résultat complet d'une analyse (écran d'analyse, page publique `/t/<mint>`, image OG). */
export const analysisResultSchema = z
  .object({
    mint: mintAddressSchema,
    token: tokenMetadataSchema,
    verdict: verdictSchema,
    /** Phrase d'explication du verdict (affichée sous le badge). */
    explanation: z.string().min(1).max(280),
    /** Les 9 contrôles, dans l'ordre de `ANALYSIS_CHECK_IDS`. */
    checks: z.array(analysisCheckSchema).length(ANALYSIS_CHECK_IDS.length),
    engineVersion: z.string().min(1).max(32),
    analyzedAt: z.iso.datetime(),
    /** Vrai si le résultat sort du cache (moins de 60 s). */
    cached: z.boolean(),
    /** Vrai si au moins une source manquait (contrôle `unavailable`) : résultat partiel. */
    degraded: z.boolean(),
  })
  .refine(
    (result) => result.checks.every((check, index) => check.id === ANALYSIS_CHECK_IDS[index]),
    { message: 'Contrôles incomplets ou dans le désordre.', path: ['checks'] },
  )
  .refine((result) => result.token.mint === result.mint, {
    message: 'Mint incohérent.',
    path: ['token', 'mint'],
  });
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

/** Réponse de `POST /api/v1/analyses` : résultat + quota restant. */
export const analysisResponseSchema = z.object({
  analysis: analysisResultSchema,
  quota: quotaInfoSchema,
});
export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;
