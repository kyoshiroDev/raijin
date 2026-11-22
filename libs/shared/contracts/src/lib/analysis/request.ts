import { ANALYSIS_INPUT_MAX_LENGTH } from '@raijin/shared-util';
import { z } from 'zod';
import { mintAddressSchema } from '../address';

/**
 * Corps de `POST /api/v1/analyses` : adresse de mint ou lien collé (DexScreener, pump.fun,
 * Solscan, Birdeye). L'API extrait l'adresse avec `extractSolanaAddress` (`@raijin/shared-util`),
 * le front fait la même extraction pour l'aperçu et la validation immédiate.
 */
export const analysisRequestSchema = z
  .object({
    input: z.string().trim().min(1).max(ANALYSIS_INPUT_MAX_LENGTH),
  })
  .strict();
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;

/** Paramètre de route `:mint` (`GET /api/v1/analyses/:mint/latest`, `/t/:mint`, image OG). */
export const mintParamSchema = z.object({ mint: mintAddressSchema }).strict();
export type MintParam = z.infer<typeof mintParamSchema>;
