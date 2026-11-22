import { sanitizeUntrustedText } from '@raijin/shared-util';
import { z } from 'zod';
import { mintAddressSchema } from '../address';

export const TOKEN_NAME_MAX_LENGTH = 64;
export const TOKEN_SYMBOL_MAX_LENGTH = 16;

/**
 * Texte externe non fiable (nom, symbole, libellé de source) : nettoyé par
 * `sanitizeUntrustedText` à la validation (contrôles, caractères invisibles et bidi retirés,
 * longueur bornée). Le parse côté front rejoue le nettoyage (défense en profondeur).
 * Toujours affiché par interpolation échappée, jamais en HTML.
 */
export function untrustedTextSchema(maxLength: number) {
  return z
    .string()
    .max(1024)
    .transform((value) => sanitizeUntrustedText(value, maxLength));
}

export const tokenProgramSchema = z.enum(['spl-token', 'token-2022']);
export type TokenProgram = z.infer<typeof tokenProgramSchema>;

/**
 * Métadonnées d'un token. `name` et `symbol` viennent du créateur du token : **non fiables**
 * (usurpation de nom possible), signalés par `untrusted: true` et affichés comme tels.
 * Aucune image en v1 : les URLs d'image des métadonnées ne sont ni stockées ni affichées.
 */
export const tokenMetadataSchema = z.object({
  mint: mintAddressSchema,
  name: untrustedTextSchema(TOKEN_NAME_MAX_LENGTH).nullable(),
  symbol: untrustedTextSchema(TOKEN_SYMBOL_MAX_LENGTH).nullable(),
  decimals: z.number().int().min(0).max(255).nullable(),
  tokenProgram: tokenProgramSchema.nullable(),
  untrusted: z.literal(true),
});
export type TokenMetadata = z.infer<typeof tokenMetadataSchema>;
