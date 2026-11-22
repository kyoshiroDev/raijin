import { waitForPortOpen } from '@nx/node/utils';

module.exports = async function () {
  // Attend que l'API soit à l'écoute avant de lancer les tests e2e.
  const host = process.env['HOST'] ?? 'localhost';
  const port = process.env['API_PORT'] ? Number(process.env['API_PORT']) : 3100;
  await waitForPortOpen(port, { host });
  globalThis.__TEARDOWN_MESSAGE__ = '\nArrêt des tests e2e de l’API.\n';
};
