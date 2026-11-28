/**
 * CLI d'administration (entrée secondaire du build : dist/apps/api/cli.js). Mince : la logique vit dans
 * `@raijin/api-auth` (`runAdminCli`). Lancée par `pnpm nx run api:make-admin --email=…` ou
 * `pnpm nx run api:admin-reset-2fa --email=…`, jamais depuis l'interface (docs/ARCHITECTURE.md §14.3).
 */
import { runAdminCli } from '@raijin/api-auth';

runAdminCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`Échec de la commande (${error instanceof Error ? error.name : 'erreur'}).`);
    process.exit(1);
  });
