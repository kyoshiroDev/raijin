import * as z from '../zod';

/**
 * Révoquer une délégation se fait **dans le wallet de l'utilisateur** : Raijin ne signe rien et ne
 * propose aucun bouton de révocation (PROMPT.md §4.3, §8). Il renvoie vers la documentation
 * officielle des wallets, liste blanche d'URLs exactes vérifiées (HTTP 200, contenu relu) le
 * 2026-11-22. Toute URL hors de cette liste est refusée par `revokeGuideUrlSchema`.
 */
export const WALLET_REVOKE_WALLETS = ['phantom', 'solflare'] as const;
export const walletRevokeWalletSchema = z.enum(WALLET_REVOKE_WALLETS);
export type WalletRevokeWallet = z.infer<typeof walletRevokeWalletSchema>;

export interface WalletRevokeGuide {
  readonly wallet: WalletRevokeWallet;
  readonly walletName: string;
  /** Libellé du lien (français ; la page cible est en anglais). */
  readonly label: string;
  /** Étapes résumées en français, affichées avant le lien. */
  readonly steps: readonly string[];
  readonly url: string;
  /** Date de la dernière vérification de l'URL (AAAA-MM-JJ). */
  readonly verifiedAt: string;
}

export const WALLET_REVOKE_GUIDES: readonly WalletRevokeGuide[] = [
  {
    wallet: 'phantom',
    walletName: 'Phantom',
    label: 'Guide Phantom : révoquer les autorisations de tokens (en anglais)',
    steps: [
      'Ouvre le guide officiel de Phantom ci-dessous.',
      'Utilise l’outil de révocation qu’il recommande pour Solana, depuis ton propre wallet.',
      'Vérifie l’adresse du site avant de connecter ton wallet, et relis chaque transaction avant de la signer.',
    ],
    url: 'https://help.phantom.com/articles/revoke-token-approvals-19142125651731',
    verifiedAt: '2026-11-22',
  },
  {
    wallet: 'solflare',
    walletName: 'Solflare',
    label: 'Solflare : approbations de tokens et révocation (en anglais)',
    steps: [
      'Dans Solflare, ouvre Paramètres, puis Sécurité et confidentialité.',
      'Passe en revue les approbations existantes et révoque celles que tu ne reconnais pas.',
    ],
    url: 'https://www.solflare.com/glossary/token-approval/',
    verifiedAt: '2026-11-22',
  },
  {
    wallet: 'solflare',
    walletName: 'Solflare',
    label: 'Solflare : comprendre les délégations (en anglais)',
    steps: ['Explique l’avertissement de Solflare quand une application demande une délégation.'],
    url: 'https://help.solflare.com/en/articles/9267797-understanding-delegations-aka-spending-approvals-in-solflare',
    verifiedAt: '2026-11-22',
  },
];

/** URLs exactes autorisées pour les liens de révocation. */
export const WALLET_REVOKE_GUIDE_URLS: readonly string[] = WALLET_REVOKE_GUIDES.map((guide) => guide.url);

/** Lien de révocation : uniquement une URL exacte de `WALLET_REVOKE_GUIDES`. */
export const revokeGuideUrlSchema = z
  .string()
  .max(2048)
  .refine((url) => WALLET_REVOKE_GUIDE_URLS.includes(url), { message: 'Lien de documentation non autorisé.' });

/** Rappel affiché sur l'écran de scan (saisie et résultats). */
export const WALLET_SCAN_READ_ONLY_NOTICE =
  'Aucune connexion de wallet, aucune signature : Raijin lit seulement les données publiques de cette adresse.';

/** Explication d'une délégation active (section « Délégations actives »). */
export const WALLET_DELEGATION_EXPLANATION =
  'Une délégation autorise une autre adresse à déplacer tes tokens sans te redemander ton accord, jusqu’au montant délégué. Si tu ne la reconnais pas, révoque-la depuis ton wallet.';
