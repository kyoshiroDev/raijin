import { join } from 'node:path';
import { startApi } from './api-server';

module.exports = async function () {
  // Lance l'API construite (api:build) sur le port des e2e et attend qu'elle écoute.
  const host = process.env['HOST'] ?? 'localhost';
  const port = process.env['API_PORT'] ? Number(process.env['API_PORT']) : 3200;
  globalThis.__API_PROCESS__ = await startApi(join(__dirname, '..', '..', '..', '..'), port, host);
  globalThis.__TEARDOWN_MESSAGE__ = '\nArrêt des tests e2e de l’API.\n';
};
