import * as z from '../zod';

/** Codes d'erreur propres à l'analyse (s'ajoutent aux codes génériques, dont QUOTA_EXCEEDED). */
export const ANALYSIS_ERROR_CODES = [
  /** Saisie sans adresse Solana reconnaissable (adresse invalide, lien non pris en charge). */
  'MINT_INVALID',
  /** Adresse valide mais pas un mint SPL / Token-2022 existant (ni une paire résoluble). */
  'TOKEN_NOT_FOUND',
  /**
   * Le compte existe mais ne peut pas être analysé (compte de plus de 2 Mo, Token-2022 aux extensions
   * volumineuses, format non pris en charge) : 422, distinct de `TOKEN_NOT_FOUND`. Cache négatif 1 h,
   * aucune collecte complète lancée (crédits Helius préservés).
   */
  'TOKEN_UNANALYZABLE',
  /** Page publique : aucune analyse récente enregistrée pour ce mint. */
  'ANALYSIS_NOT_FOUND',
] as const;

export const analysisErrorCodeSchema = z.enum(ANALYSIS_ERROR_CODES);
export type AnalysisErrorCode = z.infer<typeof analysisErrorCodeSchema>;

/** Messages français affichés par le front pour les erreurs de l'analyse (ton neutre). */
export const ANALYSIS_ERROR_MESSAGES: Readonly<
  Record<AnalysisErrorCode | 'QUOTA_EXCEEDED' | 'UPSTREAM_UNAVAILABLE' | 'RATE_LIMITED', string>
> = {
  MINT_INVALID:
    'Adresse non reconnue. Colle une adresse de token Solana ou un lien DexScreener, pump.fun, Solscan ou Birdeye.',
  TOKEN_NOT_FOUND: 'Aucun token trouvé à cette adresse sur Solana.',
  TOKEN_UNANALYZABLE:
    'Ce compte existe sur Solana, mais Raijin ne sait pas encore l’analyser (format ou taille non pris en charge).',
  ANALYSIS_NOT_FOUND: 'Ce token n’a pas encore été analysé. Lance l’analyse pour voir le verdict.',
  QUOTA_EXCEEDED: 'Tu as atteint ton quota d’analyses du jour. Il se renouvelle à minuit (UTC).',
  UPSTREAM_UNAVAILABLE:
    'Les sources de données ne répondent pas pour le moment. Réessaie dans quelques instants.',
  RATE_LIMITED: 'Trop de requêtes. Patiente quelques secondes avant de réessayer.',
};
