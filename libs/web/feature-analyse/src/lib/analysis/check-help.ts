import type { AnalysisCheckId } from '@raijin/shared-contracts';

export interface CheckHelp {
  /** Ce que mesure le contrôle. */
  readonly what: string;
  /** Pourquoi ça compte pour toi. */
  readonly why: string;
  /** Comment Raijin le vérifie (sources, méthode). */
  readonly how: string;
}

/** Textes pédagogiques des bottom sheets « En savoir plus » (statiques, rédigés par Raijin). */
export const CHECK_HELP: Readonly<Record<AnalysisCheckId, CheckHelp>> = {
  mint_authority: {
    what: 'L’autorité de mint est le droit de créer de nouveaux tokens. Tant qu’elle est active, son détenteur peut augmenter l’offre quand il veut.',
    why: 'Un créateur qui garde ce droit peut imprimer des millions de tokens et les revendre d’un coup : ta part perd sa valeur. Une autorité révoquée ne peut plus jamais être réactivée.',
    how: 'Raijin lit le compte du mint directement sur la blockchain Solana (RPC Helius, ou RPC public en secours).',
  },
  freeze_authority: {
    what: 'L’autorité de freeze permet de geler le solde d’un wallet : les tokens restent visibles mais ne peuvent plus bouger.',
    why: 'Sur un memecoin, un freeze actif permet au créateur d’empêcher les ventes. Certains émetteurs régulés (USDC, USDT) la gardent pour des raisons légales : Raijin le signale à part.',
    how: 'Raijin lit le compte du mint sur la blockchain, ainsi que les extensions Token-2022 qui donnent des pouvoirs comparables (délégué permanent, hook de transfert).',
  },
  liquidity: {
    what: 'La liquidité est l’argent disponible dans les pools pour acheter ou vendre le token. La LP représente la part de ce pool détenue par ses fournisseurs.',
    why: 'Une liquidité faible fait fortement bouger le prix à chaque échange. Si la LP n’est ni brûlée ni verrouillée, le créateur peut la retirer et vider le pool (rug).',
    how: 'Raijin prend la médiane des montants publiés par DexScreener et GeckoTerminal, et vérifie la part de LP brûlée ou verrouillée.',
  },
  holder_concentration: {
    what: 'La concentration mesure la part de l’offre détenue par les 10 plus gros wallets, sans compter la LP ni les programmes connus.',
    why: 'Quand quelques wallets détiennent une grosse part de l’offre, une seule vente peut faire chuter le prix. Raijin signale tout wallet au-dessus de 10 %.',
    how: 'Raijin récupère les plus gros comptes du token sur la blockchain, identifie leurs propriétaires et exclut les comptes de pool et de programmes.',
  },
  sell_simulation: {
    what: 'Ce contrôle vérifie qu’une vente du token est possible, en demandant un devis de vente pour un petit montant.',
    why: 'Un honeypot laisse acheter mais bloque la revente, ou la taxe lourdement. Sans route de vente, tu risques de rester coincé avec tes tokens.',
    how: 'Raijin demande un devis à l’API Jupiter. Il ne signe et n’exécute aucune transaction : il lit seulement l’impact prix et la taxe implicite du devis.',
  },
  metadata_mutable: {
    what: 'Les métadonnées sont le nom, le symbole et le logo du token. Elles sont modifiables tant que l’autorité de mise à jour existe.',
    why: 'Un créateur peut renommer son token pour imiter un projet connu, ou changer son apparence après coup. Ce n’est pas un danger en soi, mais un point de vigilance.',
    how: 'Raijin lit le compte de métadonnées du token sur la blockchain (Helius) et vérifie s’il est encore modifiable.',
  },
  token_age: {
    what: 'L’âge du token et de son pool indique depuis quand il existe et peut s’échanger.',
    why: 'Un token de quelques heures n’a presque pas d’historique : les arnaques les plus rapides se jouent souvent dans les premières heures.',
    how: 'Raijin date la création du mint (Helius) et l’ouverture du premier pool (DexScreener).',
  },
  creator_history: {
    what: 'L’historique du créateur recense les autres tokens lancés par le même wallet et ce qu’ils sont devenus.',
    why: 'Un wallet qui a déjà lancé de nombreux tokens abandonnés ou vidés est un signal fort, même si ce token-ci a l’air propre.',
    how: 'Raijin interroge l’historique du wallet créateur via Helius. Sans clé Helius, ce contrôle reste indisponible.',
  },
  rugcheck: {
    what: 'RugCheck est un service indépendant qui publie sa propre note de risque pour les tokens Solana.',
    why: 'Un second avis aide à repérer ce qu’un seul outil pourrait manquer. Il est affiché comme source complémentaire, à côté des contrôles de Raijin.',
    how: 'Raijin lit le rapport public de RugCheck pour ce token et le résume, sans le modifier.',
  },
};
