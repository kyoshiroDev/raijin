import * as z from '../zod';

/**
 * Codes d'erreur du scan de wallet (phase 5, docs/ARCHITECTURE.md §12). S'ajoutent aux codes
 * génériques (`UNAUTHORIZED` sans session, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`).
 */
export const WALLET_ERROR_CODES = [
  /** Saisie qui n'est pas une adresse publique de wallet (base58 invalide, programme, compte de token) : 400. */
  'WALLET_INVALID',
  /** L'adresse est celle d'un token (mint) : 422. Le front propose d'en lancer l'analyse. */
  'WALLET_IS_TOKEN',
  /** Scan réservé au plan Pro et à l'essai Pro : 403 (message neutre, sans urgence). */
  'WALLET_SCAN_PLAN_REQUIRED',
  /** Wallet hors normes (plus de `WALLET_SCAN_MAX_ACCOUNTS` comptes de tokens, ex. plateforme d'échange) : 422. */
  'WALLET_TOO_LARGE',
  /** Quota journalier de scans atteint : 429. Remis à zéro à minuit UTC. */
  'WALLET_SCAN_QUOTA_EXCEEDED',
] as const;

export const walletErrorCodeSchema = z.enum(WALLET_ERROR_CODES);
export type WalletErrorCode = z.infer<typeof walletErrorCodeSchema>;

/** Messages français (ton neutre, aucune urgence artificielle). */
export const WALLET_ERROR_MESSAGES: Readonly<Record<WalletErrorCode, string>> = {
  WALLET_INVALID: 'Ce n’est pas une adresse publique de wallet Solana. Copie-la depuis ton wallet (bouton Recevoir).',
  WALLET_IS_TOKEN: 'Cette adresse est celle d’un token, pas d’un wallet. Tu peux lancer son analyse.',
  WALLET_SCAN_PLAN_REQUIRED:
    'Le scan de wallet fait partie du plan Pro. Tu peux l’essayer gratuitement pendant 7 jours, sans carte bancaire.',
  WALLET_TOO_LARGE:
    'Ce wallet contient trop de comptes de tokens pour un scan. Analyse plutôt les tokens un par un.',
  WALLET_SCAN_QUOTA_EXCEEDED: 'Tu as atteint ton nombre de scans de wallet pour aujourd’hui. Il se renouvelle à minuit (UTC).',
};
