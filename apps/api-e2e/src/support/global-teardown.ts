import { stopApi } from './api-server';

module.exports = async function () {
  // Arrête uniquement le processus lancé par global-setup (jamais un autre service du même port).
  await stopApi(globalThis.__API_PROCESS__);
  console.log(globalThis.__TEARDOWN_MESSAGE__);
};
