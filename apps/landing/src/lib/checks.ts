import { ANALYSIS_CHECK_IDS, ANALYSIS_CHECK_LABELS, type AnalysisCheckId } from '@raijin/shared-contracts';

/** Source affichée pour chaque contrôle (PROMPT.md §4.1 : la source est toujours citée). */
export const CHECK_SOURCES: Readonly<Record<AnalysisCheckId, string>> = {
  mint_authority: 'Helius (RPC Solana)',
  freeze_authority: 'Helius (RPC Solana)',
  liquidity: 'DexScreener et GeckoTerminal',
  holder_concentration: 'Helius',
  sell_simulation: 'Jupiter (devis de vente)',
  metadata_mutable: 'Helius',
  token_age: 'DexScreener et GeckoTerminal',
  creator_history: 'Helius',
  rugcheck: 'RugCheck',
};

/** Ce que vérifie chaque contrôle, en une phrase (accueil, « Comment ça marche »). */
export const CHECK_DESCRIPTIONS: Readonly<Record<AnalysisCheckId, string>> = {
  mint_authority: "Quelqu'un peut-il encore créer de nouveaux tokens et diluer ta part ?",
  freeze_authority: "Quelqu'un peut-il geler les tokens dans ton wallet et t'empêcher de les déplacer ?",
  liquidity: 'Combien de liquidité, et quelle part de la LP est brûlée ou verrouillée ?',
  holder_concentration: 'Quelle part du supply détiennent les 10 plus gros wallets, LP et programmes exclus ?',
  sell_simulation: 'Un devis de vente existe-t-il, et avec quelle taxe implicite ? Simulation seule, rien n’est signé.',
  metadata_mutable: 'Le nom, le symbole ou le logo peuvent-ils encore être changés ?',
  token_age: 'Depuis quand le token et son pool existent-ils ?',
  creator_history: 'Le wallet créateur a-t-il déjà lancé des tokens morts ou victimes d’un rug ?',
  rugcheck: 'Que signale RugCheck, affiché comme source complémentaire ?',
};

/** Contrôles critiques : un seul signal suffit pour le verdict Danger (docs/SCORING.md). */
export const CRITICAL_CHECKS: readonly AnalysisCheckId[] = [
  'mint_authority',
  'freeze_authority',
  'liquidity',
  'sell_simulation',
];

export const CHECKS = ANALYSIS_CHECK_IDS.map((id) => ({
  id,
  label: ANALYSIS_CHECK_LABELS[id],
  description: CHECK_DESCRIPTIONS[id],
  source: CHECK_SOURCES[id],
  critical: CRITICAL_CHECKS.includes(id),
}));
