import { tokenRowSchema } from '@raijin/bench-contracts';

/** Colonnes de `public.tokens` exposées au front (contrat `tokenRowSchema`, ex-`TOKEN_COLUMNS` du front Supabase). */
export const TOKEN_COLUMN_NAMES: readonly string[] = Object.keys(tokenRowSchema.shape);
export const TOKEN_COLUMNS = TOKEN_COLUMN_NAMES.join(',');
