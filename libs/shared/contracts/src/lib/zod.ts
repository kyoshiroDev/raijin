import { config } from 'zod';

/**
 * Zod des contrats : tous les schémas importent `* as z` depuis ce module, ce qui garantit que la
 * configuration ci-dessous s'exécute avant leur création (un simple import d'effet dans `index.ts`
 * était réordonné par le bundler du front, après les schémas).
 *
 * `jitless` : Zod 4 ne teste plus `new Function` pour compiler les parseurs d'objets. Côté front, ce
 * test déclenche une violation de la CSP (`script-src 'self'`, sans `'unsafe-eval'`), signalée par
 * Lighthouse (Best Practices, `inspector-issues`), et coûte une compilation au premier parse. Même
 * réglage côté API et banc : le parse est identique partout (docs/ARCHITECTURE.md §10).
 */
config({ jitless: true });

export * from 'zod';
