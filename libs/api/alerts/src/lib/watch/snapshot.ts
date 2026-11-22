import { tokenMetadataSchema, watchSnapshotSchema, type TokenMetadata, type WatchSnapshot } from '@raijin/shared-contracts';

/** Instantané stocké, revalidé par le contrat (une ligne altérée ou d'une ancienne version = `null`). */
export function parseSnapshot(value: unknown): WatchSnapshot | null {
  if (value === null || value === undefined) return null;
  const parsed = watchSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Métadonnées stockées (non fiables), nettoyées par le contrat. */
export function parseToken(value: unknown): TokenMetadata | null {
  if (value === null || value === undefined) return null;
  const parsed = tokenMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
