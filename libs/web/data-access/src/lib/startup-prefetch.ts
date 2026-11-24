import { DOCUMENT } from '@angular/common';
import { inject, makeEnvironmentProviders, provideAppInitializer, type EnvironmentProviders } from '@angular/core';
import { isSolanaAddress } from '@raijin/shared-util';
import { AnalysisPrefetch, type EarlyAnalysis } from './analysis/analysis-prefetch';
import { CSRF_TOKEN_PATTERN, CsrfToken } from './auth/csrf-token';
import { API_BASE_URL } from './config/api-config';
import { prefetchContracts } from './contracts';

/** Base des requêtes du script `analyse-prefetch.js` (doit être celle de l'app pour qu'elles soient reprises). */
export const EARLY_STARTUP_API_BASE = '/api/v1';

/** Préchargement lancé par `apps/web/public/analyse-prefetch.js` avant Angular (`window.__rjStartup`). */
export interface EarlyStartup {
  readonly mint: string;
  readonly startedAt: number;
  readonly csrf: Promise<string>;
  readonly analysis: Promise<EarlyAnalysis>;
}

/** Lit puis efface `window.__rjStartup` (une seule reprise, aucune trace laissée sur `window`). */
export function takeEarlyStartup(view: Window | null): EarlyStartup | null {
  if (!view) return null;
  const holder = view as unknown as { __rjStartup?: unknown };
  const value = holder.__rjStartup;
  delete holder.__rjStartup;
  if (typeof value !== 'object' || value === null) return null;
  const early = value as Partial<EarlyStartup>;
  if (
    typeof early.mint !== 'string' ||
    typeof early.startedAt !== 'number' ||
    !(early.csrf instanceof Promise) ||
    !(early.analysis instanceof Promise)
  ) {
    return null;
  }
  return early as EarlyStartup;
}

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
      const document = inject(DOCUMENT);
      const path = document.location?.pathname ?? '';
      const matches = (patterns: readonly RegExp[] | undefined) => patterns?.some((pattern) => pattern.test(path)) ?? false;
      const mint = options.analyze ? decodeMint(options.analyze.exec(path)?.[1]) : null;
      const validMint = mint && isSolanaAddress(mint) ? mint : null;
      // Requêtes déjà parties avec le HTML (analyse-prefetch.js) : reprises au lieu d'être renvoyées.
      const early = takeEarlyStartup(document.defaultView);
      const adopt = early !== null && validMint !== null && early.mint === validMint && inject(API_BASE_URL) === EARLY_STARTUP_API_BASE;
      const csrf = inject(CsrfToken);
      if (adopt) {
        early.csrf.then(
          (token) => {
            if (CSRF_TOKEN_PATTERN.test(token) && !csrf.token()) csrf.set(token);
          },
          () => undefined,
        );
      } else if (matches(options.csrf)) {
        csrf.ensure().subscribe({ error: () => undefined });
      }
      if (matches(options.contracts)) prefetchContracts();
      if (!validMint) return;
      if (adopt) inject(AnalysisPrefetch).adopt(validMint, early.startedAt, early.analysis);
      else inject(AnalysisPrefetch).start(validMint);
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
