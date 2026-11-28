import { config } from 'zod';

/**
 * Même réglage que `@raijin/shared-contracts` (docs/ARCHITECTURE.md §10) : `jitless` évite le test
 * `new Function` de Zod 4, interdit par la CSP du front du banc. Tous les schémas du banc importent
 * `* as z` depuis ce module pour que la configuration s'exécute avant leur création.
 */
config({ jitless: true });

export * from 'zod';
