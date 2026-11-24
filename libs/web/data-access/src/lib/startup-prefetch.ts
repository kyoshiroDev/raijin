import { DOCUMENT } from '@angular/common';
import { inject, makeEnvironmentProviders, provideAppInitializer, type EnvironmentProviders } from '@angular/core';
import { isSolanaAddress } from '@raijin/shared-util';
import { AnalysisPrefetch, type EarlyAnalysis } from './analysis/analysis-prefetch';
import { CSRF_TOKEN_PATTERN, CsrfToken } from './auth/csrf-token';
import { API_BASE_URL } from './config/api-config';
import { prefetchContracts } from './contracts';

/** Base des requêtes du script `analyse-prefetch.js` (doit être celle de l'app pour qu'elles soient reprises). */
export const EARLY_STARTUP_API_BASE = '/api/v1';

/**
 * Attente maximale du premier rendu derrière une requête lancée avec le HTML : la réponse arrive le plus souvent
 * avant la fin du chargement d'Angular ; sinon l'écran s'affiche (état de chargement) sans l'attendre davantage.
 */
export const EARLY_STARTUP_MAX_WAIT_MS = 1000;

/**
 * Préchargement lancé par `apps/web/public/analyse-prefetch.js` avant Angular (`window.__rjStartup`) :
 * `analyse` = CSRF puis `POST analyses` (`/analyse/<mint>`) ; `latest` = `GET analyses/:mint/latest` (`/t/<mint>`).
 */
export type EarlyStartup =
  | {
      readonly kind: 'analyse';
      readonly mint: string;
      readonly startedAt: number;
      readonly csrf: Promise<string>;
      readonly analysis: Promise<EarlyAnalysis>;
    }
  | { readonly kind: 'latest'; readonly mint: string; readonly startedAt: number; readonly latest: Promise<EarlyAnalysis> };

/** Lit puis efface `window.__rjStartup` (une seule reprise, aucune trace laissée sur `window`). */
export function takeEarlyStartup(view: Window | null): EarlyStartup | null {
  if (!view) return null;
  const holder = view as unknown as { __rjStartup?: unknown };
  const value = holder.__rjStartup;
  delete holder.__rjStartup;
  if (typeof value !== 'object' || value === null) return null;
  const early = value as Record<string, unknown>;
  if (typeof early['mint'] !== 'string' || typeof early['startedAt'] !== 'number') return null;
  if (early['kind'] === 'analyse' && early['csrf'] instanceof Promise && early['analysis'] instanceof Promise) {
    return early as unknown as EarlyStartup;
  }
  if (early['kind'] === 'latest' && early['latest'] instanceof Promise) return early as unknown as EarlyStartup;
  return null;
}

/**
 * Laisse le premier rendu attendre la réponse lancée avec le HTML (au plus `EARLY_STARTUP_MAX_WAIT_MS`) : le
 * verdict est alors dans la première image (pas de squelette remplacé aussitôt, deux rendus de moins après
 * l'affichage : TBT et LCP stables, docs/ARCHITECTURE.md §10.6).
 */
function settledOrTimeout(view: Window | null, request: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = view ? view.setTimeout(resolve, EARLY_STARTUP_MAX_WAIT_MS) : null;
    request.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (timer !== null) view?.clearTimeout(timer);
      resolve();
    });
  });
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
  /**
   * Page publique d'arrivée (`/t/<mint>`, mint en premier groupe) : la lecture lancée avec le HTML par
   * `analyse-prefetch.js` est reprise par `AnalysisStore.loadLatest` (aucune seconde requête).
   */
  readonly latest?: RegExp;
}

/**
 * Préchargements du démarrage selon la page d'arrivée (docs/ARCHITECTURE.md §10.2) : rien n'est
 * demandé sur les autres pages. Un échec est sans conséquence (redemandé au moment du besoin).
 */
export function provideStartupPrefetch(options: StartupPrefetchOptions): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => {
      const document = inject(DOCUMENT);
      const view = document.defaultView;
      const path = document.location?.pathname ?? '';
      const matches = (patterns: readonly RegExp[] | undefined) => patterns?.some((pattern) => pattern.test(path)) ?? false;
      const validMint = (pattern: RegExp | undefined) => {
        const mint = pattern ? decodeMint(pattern.exec(path)?.[1]) : null;
        return mint && isSolanaAddress(mint) ? mint : null;
      };
      const analyzeMint = validMint(options.analyze);
      const latestMint = validMint(options.latest);
      // Requêtes déjà parties avec le HTML (analyse-prefetch.js) : reprises au lieu d'être renvoyées.
      const sameBase = inject(API_BASE_URL) === EARLY_STARTUP_API_BASE;
      const early = takeEarlyStartup(view);
      const prefetch = inject(AnalysisPrefetch);
      const csrf = inject(CsrfToken);
      if (matches(options.contracts)) prefetchContracts();

      if (early?.kind === 'latest' && sameBase && latestMint !== null && early.mint === latestMint) {
        prefetch.adoptLatest(latestMint, early.startedAt, early.latest);
        return settledOrTimeout(view, early.latest);
      }
      if (early?.kind === 'analyse' && sameBase && analyzeMint !== null && early.mint === analyzeMint) {
        early.csrf.then(
          (token) => {
            if (CSRF_TOKEN_PATTERN.test(token) && !csrf.token()) csrf.set(token);
          },
          () => undefined,
        );
        prefetch.adopt(analyzeMint, early.startedAt, early.analysis);
        return settledOrTimeout(view, early.analysis);
      }
      if (matches(options.csrf)) csrf.ensure().subscribe({ error: () => undefined });
      if (analyzeMint) prefetch.start(analyzeMint);
      return undefined;
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
