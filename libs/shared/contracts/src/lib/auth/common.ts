import { z } from 'zod';

/** Longueur maximale d'une adresse e-mail (RFC 5321). */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Adresse e-mail saisie : espaces retirés, mise en minuscules. La normalisation anti-abus
 * (alias `+`, points Gmail) est calculée côté API (`emailNormalized`), jamais par le front.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH, { message: 'Adresse e-mail trop longue.' })
  .pipe(z.email({ message: 'Adresse e-mail invalide.' }));
export type Email = z.infer<typeof emailSchema>;

/** Jeton opaque reçu par e-mail (base64url, 32 octets aléatoires minimum côté API). */
export const opaqueTokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{32,128}$/, { message: 'Lien invalide.' });

// Caractères de contrôle (C0, DEL, C1) : refusés dans les chemins et champs d'attribution.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Chemin relatif interne à l'app (redirection après lien magique, page d'arrivée) :
 * commence par un seul `/`, sans schéma, sans `//` ni `\` (pas de redirection ouverte).
 */
export const relativePathSchema = z
  .string()
  .trim()
  .max(512)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.includes('\\') &&
      !CONTROL_CHARS.test(value),
    { message: 'Chemin invalide.' },
  );

/** Texte court venant de l'extérieur (UTM) : sans caractère de contrôle, borné. */
export const externalLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !CONTROL_CHARS.test(value), { message: 'Valeur invalide.' });

/** Réponse neutre (202) des demandes qui ne doivent rien révéler (inscription, oubli, lien magique). */
export const messageResponseSchema = z.object({ message: z.string().min(1) });
export type MessageResponse = z.infer<typeof messageResponseSchema>;
