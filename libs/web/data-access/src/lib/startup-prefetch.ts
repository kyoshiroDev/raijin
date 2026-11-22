import { DOCUMENT } from '@angular/common';
import { inject, makeEnvironmentProviders, provideAppInitializer, type EnvironmentProviders } from '@angular/core';
import { isSolanaAddress } from '@raijin/shared-util';
import { AnalysisPrefetch } from './analysis/analysis-prefetch';
import { CsrfToken } from './auth/csrf-token';
import { prefetchContracts } from './contracts';

export interface StartupPrefetchOptions {
  /**
   * Pages d'arrivée qui envoient une mutation dès leur ouverture (ex. `/analyse/<mint>` → `POST
   * analyses`) : le jeton CSRF y est demandé pendant la création de l'app, au lieu de l'être juste
   * avant la mutation (un aller-retour de moins avant l'élément LCP).
   */
  readonly csrf?: readonly RegExp[];
  /**
   * Pages d'arrivée qui affichent une analyse dès leur ouverture : le chunk des contrats
   * (et Zod) est demandé au démarrage, en parallèle de la requête, plutôt qu'en cascade derrière elle.
   */
  readonly contracts?: readonly RegExp[];
  /**
   * Page d'arrivée qui lance une analyse à son ouverture (`/analyse/<mint>`, le mint étant le
   * premier groupe capturé) : `POST analyses` part au démarrage et l'écran réclame cette requête
   * (`AnalysisPrefetch`), sans en envoyer une seconde. Ignoré si le mint n'est pas une adresse valide.
   */
  readonly analyze?: RegExp;
}

/**
 * Préchargements du démarrage selon la page d'arrivée (docs/ARCHITECTURE.md §10.2) : rien n'est
 * demandé sur les autres pages. Un échec est sans conséquence (redemandé au moment du besoin).
 */
export function provideStartupPrefetch(options: StartupPrefetchOptions): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => {
      const path = inject(DOCUMENT).location?.pathname ?? '';
      const matches = (patterns: readonly RegExp[] | undefined) => patterns?.some((pattern) => pattern.test(path)) ?? false;
      if (matches(options.csrf)) inject(CsrfToken).ensure().subscribe({ error: () => undefined });
      if (matches(options.contracts)) prefetchContracts();
      const mint = options.analyze ? decodeMint(options.analyze.exec(path)?.[1]) : null;
      if (mint && isSolanaAddress(mint)) inject(AnalysisPrefetch).start(mint);
    }),
  ]);
}

function decodeMint(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
