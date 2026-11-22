import * as z from '../zod';

/**
 * Double authentification TOTP du compte admin (RFC 6238 : SHA-1, 6 chiffres, pas de 30 s, fenêtre ±1 pas) et
 * session admin courte (docs/ARCHITECTURE.md §14.2 et §14.3). Routes (session de l'app + rôle ADMIN relu en base,
 * CSRF sur les POST) :
 * - `GET admin/security/status` → `AdminSecurityStatus`
 * - `POST admin/security/enrollment` → `AdminEnrollmentStart` (409 `ADMIN_2FA_ALREADY_ENROLLED`)
 * - `POST admin/security/enrollment/confirm` `AdminEnrollmentConfirmRequest` → `AdminEnrollmentConfirmResponse`
 * - `POST admin/security/verify` `AdminVerifyRequest` → `AdminSecurityStatus` (400 `ADMIN_2FA_INVALID`, 429 `ADMIN_2FA_LOCKED`)
 * - `POST admin/security/recovery-codes` `AdminRegenerateRecoveryCodesRequest` → `AdminRecoveryCodes` (session admin vérifiée)
 * - `POST admin/security/end` → 204 (quitte l'espace admin, la session de l'app reste ouverte)
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const ADMIN_RECOVERY_CODE_COUNT = 10;
/** Délai pour confirmer un enrôlement commencé (secret en attente), en secondes. */
export const ADMIN_ENROLLMENT_TTL_SECONDS = 600;

/** Code à 6 chiffres ; les espaces saisis (« 123 456 ») sont retirés. */
export const totpCodeSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, { message: 'Le code contient 6 chiffres.' }));

/** Code de secours `ABCDE-FGH23` (base32 majuscules, 50 bits) ; casse et espaces tolérés à la saisie. */
export const recoveryCodeSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/, { message: 'Code de secours invalide.' }));

/** Second facteur : code de l'application (TOTP) ou code de secours (usage unique). */
export const adminSecondFactorSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('totp'), code: totpCodeSchema }).strict(),
  z.object({ method: z.literal('recovery'), code: recoveryCodeSchema }).strict(),
]);
export type AdminSecondFactor = z.infer<typeof adminSecondFactorSchema>;

export const adminSecurityStatusSchema = z.object({
  /** 2FA activée (secret confirmé). */
  enrolled: z.boolean(),
  /** Cette session a saisi un code valide et n'a pas expiré. */
  verified: z.boolean(),
  /** Fin de la session admin si aucune activité (glissante) ; `null` si non vérifiée. */
  idleExpiresAt: z.iso.datetime().nullable(),
  /** Fin absolue de la session admin (`ADMIN_SESSION_MAX_HOURS` après la saisie du code) ; `null` si non vérifiée. */
  absoluteExpiresAt: z.iso.datetime().nullable(),
  /** `ADMIN_SESSION_IDLE_MINUTES` en secondes : le minuteur d'inactivité du front s'y aligne. */
  idleTimeoutSeconds: z.number().int().min(60),
  /** Codes de secours encore utilisables ; `null` si non enrôlé. Le front alerte sous 3. */
  recoveryCodesRemaining: z.number().int().min(0).max(ADMIN_RECOVERY_CODE_COUNT).nullable(),
});
export type AdminSecurityStatus = z.infer<typeof adminSecurityStatusSchema>;

/**
 * Début d'enrôlement. Le secret (160 bits, base32) n'est montré qu'ici, pour la saisie manuelle ; il est stocké
 * chiffré (AES-256-GCM) et n'est plus jamais renvoyé. Le QR code est un SVG généré par l'API, affiché par
 * `<img [src]>` (jamais injecté dans le DOM).
 */
export const adminEnrollmentStartSchema = z.object({
  otpauthUri: z.string().startsWith('otpauth://totp/').max(512),
  secret: z.string().regex(/^[A-Z2-7]{32}$/),
  qrCodeDataUri: z.string().startsWith('data:image/svg+xml;base64,').max(200_000),
  expiresAt: z.iso.datetime(),
});
export type AdminEnrollmentStart = z.infer<typeof adminEnrollmentStartSchema>;

export const adminEnrollmentConfirmRequestSchema = z.object({ code: totpCodeSchema }).strict();
export type AdminEnrollmentConfirmRequest = z.infer<typeof adminEnrollmentConfirmRequestSchema>;

/** Codes de secours affichés **une seule fois** (stockés hachés) : le front propose de les copier ou télécharger. */
export const adminRecoveryCodesSchema = z.object({
  codes: z.array(recoveryCodeSchema).length(ADMIN_RECOVERY_CODE_COUNT),
  generatedAt: z.iso.datetime(),
});
export type AdminRecoveryCodes = z.infer<typeof adminRecoveryCodesSchema>;

/** Confirmation : la 2FA est activée et la session est vérifiée dans la foulée. */
export const adminEnrollmentConfirmResponseSchema = z.object({
  status: adminSecurityStatusSchema,
  recoveryCodes: adminRecoveryCodesSchema,
});
export type AdminEnrollmentConfirmResponse = z.infer<typeof adminEnrollmentConfirmResponseSchema>;

export const adminVerifyRequestSchema = adminSecondFactorSchema;
export type AdminVerifyRequest = z.infer<typeof adminVerifyRequestSchema>;

/** Régénérer les codes de secours exige un code TOTP frais (les anciens codes sont invalidés). */
export const adminRegenerateRecoveryCodesRequestSchema = z.object({ code: totpCodeSchema }).strict();
export type AdminRegenerateRecoveryCodesRequest = z.infer<typeof adminRegenerateRecoveryCodesRequestSchema>;
