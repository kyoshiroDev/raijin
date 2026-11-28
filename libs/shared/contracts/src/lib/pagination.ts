import * as z from './zod';

/** Taille de page par défaut et maximale des listes paginées (alertes…). */
export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 50;

/**
 * Curseur opaque de pagination (base64url, construit par l'API à partir de `createdAt` + `id`).
 * Le front ne le décode jamais : il renvoie tel quel le `nextCursor` reçu.
 */
export const pageCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/, { message: 'Curseur invalide.' });
export type PageCursor = z.infer<typeof pageCursorSchema>;

/** Paramètres de requête communs (`?cursor=…&limit=…`, valeurs reçues en texte). */
export const pageQueryShape = {
  cursor: pageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
};

/** Réponse paginée par curseur : `nextCursor` vaut `null` sur la dernière page. */
export function pageResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item).max(PAGE_LIMIT_MAX),
    nextCursor: pageCursorSchema.nullable(),
  });
}
