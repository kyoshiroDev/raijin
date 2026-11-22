import { z } from 'zod';

/**
 * Règles de mot de passe (NIST SP 800-63B) : longueur seule, pas de règles de composition.
 * Le maximum borne le coût d'argon2id. Le refus d'un mot de passe identique à l'e-mail
 * est vérifié par l'API (`AUTH_PASSWORD_REJECTED`).
 */
export const PASSWORD_RULES = {
  minLength: 12,
  maxLength: 128,
} as const;

/** Libellé affiché sous le champ (une seule source pour le front et les e-mails). */
export const PASSWORD_HINT = `Au moins ${PASSWORD_RULES.minLength} caractères. Une phrase facile à retenir fait très bien l’affaire.`;

/** Nouveau mot de passe (inscription, réinitialisation, changement). Jamais retaillé (`trim`). */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_RULES.minLength, {
    message: `Au moins ${PASSWORD_RULES.minLength} caractères.`,
  })
  .max(PASSWORD_RULES.maxLength, {
    message: `${PASSWORD_RULES.maxLength} caractères maximum.`,
  })
  .refine((value) => value.trim().length >= PASSWORD_RULES.minLength, {
    message: 'Le mot de passe ne peut pas être fait d’espaces.',
  });

/** Mot de passe saisi à la connexion : aucune règle de longueur minimale (pas d'indice donné). */
export const currentPasswordSchema = z
  .string()
  .min(1, { message: 'Mot de passe requis.' })
  .max(PASSWORD_RULES.maxLength, { message: 'E-mail ou mot de passe incorrect.' });
