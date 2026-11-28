import { config } from 'zod';

/**
 * Zod des contrats du banc : même réglage que `@raijin/shared-contracts` (`jitless`, aucun
 * `new Function`, compatible avec la CSP du front du banc). Tous les schémas importent `* as z`
 * depuis ce module pour que la configuration s'exécute avant leur création.
 */
config({ jitless: true });

export * from 'zod';
