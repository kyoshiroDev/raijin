import { isSolanaAddress } from '@raijin/shared-util';
import { z } from 'zod';

/**
 * Tableau externe toléré élément par élément : un élément malformé (donnée hostile ou format
 * inattendu) est ignoré au lieu de rendre toute la réponse invalide. Taille bornée.
 */
export function lenientArray<T>(item: z.ZodType<T>, max: number) {
  return z
    .array(z.unknown())
    .max(max)
    .transform((items) =>
      items.flatMap((value) => {
        const parsed = item.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

/** Adresse Solana optionnelle : toute valeur invalide (chaîne vide, texte) devient `null`. */
export const optionalAddress = z
  .unknown()
  .transform((value) => (typeof value === 'string' && isSolanaAddress(value) ? value : null))
  .optional();
