import { killPort } from '@nx/node/utils';

module.exports = async function () {
  const port = process.env['API_PORT'] ? Number(process.env['API_PORT']) : 3000;
  await killPort(port);
  console.log(globalThis.__TEARDOWN_MESSAGE__);
};
