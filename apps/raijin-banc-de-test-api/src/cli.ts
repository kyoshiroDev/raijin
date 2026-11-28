import { benchCliMain } from '@raijin/bench-core';

/**
 * CLI du compte unique du banc, lancée par l'utilisateur dans le conteneur :
 * `docker compose --profile bench exec raijin-bench-api node cli.js create-owner | set-password | reset-2fa`.
 */
void benchCliMain(process.argv.slice(2), process.env).then((code) => process.exit(code));
