import * as z from '../zod';

/**
 * Les 9 contrôles de l'analyse (PROMPT.md §4.1), dans l'ordre d'affichage.
 * Identifiants stables : persistés dans `TokenAnalysis.checks`, utilisés par le banc.
 */
export const ANALYSIS_CHECK_IDS = [
  'mint_authority',
  'freeze_authority',
  'liquidity',
  'holder_concentration',
  'sell_simulation',
  'metadata_mutable',
  'token_age',
  'creator_history',
  'rugcheck',
] as const;

export const analysisCheckIdSchema = z.enum(ANALYSIS_CHECK_IDS);
export type AnalysisCheckId = z.infer<typeof analysisCheckIdSchema>;

/** Titres français des contrôles (accordéons, e-mails, image OG). */
export const ANALYSIS_CHECK_LABELS: Readonly<Record<AnalysisCheckId, string>> = {
  mint_authority: 'Autorité de mint',
  freeze_authority: 'Autorité de freeze',
  liquidity: 'Liquidité',
  holder_concentration: 'Concentration des holders',
  sell_simulation: 'Revente possible',
  metadata_mutable: 'Métadonnées modifiables',
  token_age: 'Âge du token et du pool',
  creator_history: 'Historique du créateur',
  rugcheck: 'Rapport RugCheck',
};
