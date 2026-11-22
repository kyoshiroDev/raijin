import * as z from '../zod';

/**
 * Codes d'erreur de l'espace admin (phase 6 bis, docs/ARCHITECTURE.md §14). S'ajoutent aux codes génériques.
 * Un compte qui n'est pas ADMIN reçoit **404 `NOT_FOUND`** sur toute route `admin/*` (espace invisible) : aucun
 * de ces codes ne lui est jamais renvoyé, sauf `ACCOUNT_SUSPENDED`.
 *
 * Les codes de session admin sont en **403** (jamais 401) : le front ne tente pas de refresh, il affiche l'écran
 * de saisie du code (la session de l'app, elle, reste valide).
 */
export const ADMIN_ERROR_CODES = [
  /** Compte ADMIN sans 2FA activée : toute route admin hors `admin/security/*` répond 403. Le front ouvre l'enrôlement. */
  'ADMIN_2FA_ENROLLMENT_REQUIRED',
  /** 2FA activée mais cette session n'a pas encore saisi de code : 403. */
  'ADMIN_2FA_REQUIRED',
  /** Session admin expirée (30 min d'inactivité ou durée maximale atteinte) : 403, nouveau code demandé. */
  'ADMIN_SESSION_EXPIRED',
  /** Code TOTP ou code de secours faux, expiré ou déjà utilisé : 400. */
  'ADMIN_2FA_INVALID',
  /** Trop de codes faux : 429, attente de quelques minutes (compteur par compte). */
  'ADMIN_2FA_LOCKED',
  /** Enrôlement demandé alors que la 2FA est déjà active : 409 (réinitialisation par la CLI seulement). */
  'ADMIN_2FA_ALREADY_ENROLLED',
  /** Confirmation d'enrôlement sans enrôlement en cours (ou expiré après 10 min) : 409. */
  'ADMIN_2FA_ENROLLMENT_EXPIRED',
  /** Action admin impossible dans l'état du compte visé (ex. prolonger un essai refusé, agir sur un admin, sur soi) : 409. */
  'ADMIN_ACTION_NOT_ALLOWED',
  /** L'e-mail recopié pour confirmer une action ne correspond pas au compte visé : 400. */
  'ADMIN_CONFIRMATION_MISMATCH',
  /** Connexion (mot de passe correct ou lien magique) d'un compte suspendu par l'admin : 403. */
  'ACCOUNT_SUSPENDED',
] as const;

export const adminErrorCodeSchema = z.enum(ADMIN_ERROR_CODES);
export type AdminErrorCode = z.infer<typeof adminErrorCodeSchema>;

/** Messages français (ton neutre, tutoiement de la charte). */
export const ADMIN_ERROR_MESSAGES: Readonly<Record<AdminErrorCode, string>> = {
  ADMIN_2FA_ENROLLMENT_REQUIRED: 'Active la double authentification pour ouvrir l’espace admin.',
  ADMIN_2FA_REQUIRED: 'Saisis le code de ton application d’authentification pour continuer.',
  ADMIN_SESSION_EXPIRED: 'Ta session admin a expiré après une période d’inactivité. Saisis un nouveau code.',
  ADMIN_2FA_INVALID: 'Ce code n’est pas valide. Vérifie l’heure de ton téléphone et réessaie.',
  ADMIN_2FA_LOCKED: 'Trop de codes incorrects. Patiente quelques minutes avant de réessayer.',
  ADMIN_2FA_ALREADY_ENROLLED: 'La double authentification est déjà active sur ce compte.',
  ADMIN_2FA_ENROLLMENT_EXPIRED: 'L’activation a expiré. Recommence depuis le début.',
  ADMIN_ACTION_NOT_ALLOWED: 'Cette action n’est pas possible pour ce compte dans son état actuel.',
  ADMIN_CONFIRMATION_MISMATCH: 'L’adresse saisie ne correspond pas à ce compte.',
  ACCOUNT_SUSPENDED: 'Ce compte est suspendu. Contacte-nous si tu penses qu’il s’agit d’une erreur.',
};
