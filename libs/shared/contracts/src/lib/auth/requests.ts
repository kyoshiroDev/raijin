import { z } from 'zod';
import { signupAttributionSchema } from './attribution';
import { emailSchema, opaqueTokenSchema, relativePathSchema } from './common';
import { currentPasswordSchema, newPasswordSchema } from './password';

/** POST /api/v1/auth/register → 202 `MessageResponse` (réponse identique si l'e-mail existe déjà). */
export const registerRequestSchema = z.object({
  email: emailSchema,
  password: newPasswordSchema,
  /** Acceptation explicite des CGU et de la politique de confidentialité. */
  acceptTerms: z.literal(true, { message: 'Accepte les conditions pour continuer.' }),
  attribution: signupAttributionSchema.optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/** POST /api/v1/auth/login → 200 `AuthSession` + cookies. */
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: currentPasswordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** POST /api/v1/auth/magic-link → 202 `MessageResponse` (même réponse que le compte existe ou non). */
export const magicLinkRequestSchema = z.object({
  email: emailSchema,
  /** Page de l'app où revenir après connexion (chemin relatif uniquement). */
  redirectPath: relativePathSchema.optional(),
});
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;

/** POST /api/v1/auth/magic-link/verify → 200 `AuthSession` + cookies (jeton à usage unique). */
export const magicLinkVerifyRequestSchema = z.object({ token: opaqueTokenSchema });
export type MagicLinkVerifyRequest = z.infer<typeof magicLinkVerifyRequestSchema>;

/** POST /api/v1/auth/verify-email → 200 `AuthSession` (jeton à usage unique). */
export const verifyEmailRequestSchema = z.object({ token: opaqueTokenSchema });
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

/**
 * POST /api/v1/auth/verify-email/resend → 202 `MessageResponse`.
 * Connecté : corps vide (e-mail de la session). Déconnecté : e-mail fourni, réponse neutre.
 */
export const resendVerificationRequestSchema = z.object({ email: emailSchema.optional() });
export type ResendVerificationRequest = z.infer<typeof resendVerificationRequestSchema>;

/** POST /api/v1/auth/password/forgot → 202 `MessageResponse` (réponse neutre). */
export const forgotPasswordRequestSchema = z.object({ email: emailSchema });
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

/** POST /api/v1/auth/password/reset → 204. Révoque toutes les sessions de l'utilisateur. */
export const resetPasswordRequestSchema = z.object({
  token: opaqueTokenSchema,
  password: newPasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

/** POST /api/v1/auth/password/change (connecté) → 204. Révoque les autres sessions. */
export const changePasswordRequestSchema = z
  .object({
    currentPassword: currentPasswordSchema,
    newPassword: newPasswordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'Choisis un mot de passe différent de l’actuel.',
    path: ['newPassword'],
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
