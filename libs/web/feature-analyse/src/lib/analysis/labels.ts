import type { AnalysisCheckId, CheckStatus, Verdict } from '@raijin/shared-contracts';

/**
 * Copies des constantes d'affichage de `@raijin/shared-contracts`. Les modules des contrats
 * déclarent aussi des schémas Zod (appels exécutés au chargement) : importer une seule constante
 * ferait entrer tout Zod (≈ 440 kB brut) dans le chemin critique de `/analyse`. Les schémas
 * n'arrivent qu'avec la première réponse à valider (`loadContracts`).
 * L'égalité avec les contrats est vérifiée par `labels.spec.ts` : toute divergence casse les tests.
 */
export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  safe: 'Sain',
  warn: 'Prudence',
  danger: 'Danger',
};

export const CHECK_STATUS_LABELS: Readonly<Record<CheckStatus, string>> = {
  ok: 'OK',
  warn: 'Attention',
  danger: 'Danger',
  unavailable: 'Indisponible',
};

export const ANALYSIS_CHECK_IDS: readonly AnalysisCheckId[] = [
  'mint_authority',
  'freeze_authority',
  'liquidity',
  'holder_concentration',
  'sell_simulation',
  'metadata_mutable',
  'token_age',
  'creator_history',
  'rugcheck',
];

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

export const EXTERNAL_LINK_HOSTS: readonly string[] = [
  'dexscreener.com',
  'geckoterminal.com',
  'jup.ag',
  'rugcheck.xyz',
  'solscan.io',
  'explorer.solana.com',
  'pump.fun',
  'birdeye.so',
];

export const ANALYSIS_DISCLAIMER = 'Information en lecture seule, pas un conseil en investissement.';

export const SAFE_VERDICT_REMINDER = 'Aucun signal détecté ne veut pas dire sans risque.';

/** Messages d'erreur affichés sans appel réseau (adresse invalide, page publique vide). */
export const LOCAL_ERROR_MESSAGES = {
  MINT_INVALID:
    'Adresse non reconnue. Colle une adresse de token Solana ou un lien DexScreener, pump.fun, Solscan ou Birdeye.',
  ANALYSIS_NOT_FOUND: 'Ce token n’a pas encore été analysé. Lance l’analyse pour voir le verdict.',
} as const;
