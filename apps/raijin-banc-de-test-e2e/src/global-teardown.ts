import { rmSync } from 'node:fs';
import { OWNER_STATE_FILE, STORAGE_STATE_FILE } from './support/bench';
import { deleteFixtures, deleteOwner, withDb } from './support/db';

/** Supprime le propriétaire de test (sessions, TOTP et codes de secours en cascade) et les fixtures. */
export default async function globalTeardown(): Promise<void> {
  await withDb(async (db) => {
    await deleteOwner(db);
    await deleteFixtures(db);
  });
  rmSync(OWNER_STATE_FILE, { force: true });
  rmSync(STORAGE_STATE_FILE, { force: true });
}
