import { Injectable, InjectionToken, inject } from '@angular/core';
import { BENCH_EVENT_TYPES, BENCH_ROUTES, BENCH_SSE_PATH, benchEventSchema, type BenchEvent } from '@raijin/bench-contracts';
import { BenchApi, isBenchApiError } from './bench-api';

/**
 * Flux SSE du banc (`GET /api/events?topics=…`), remplaçant des canaux Realtime `tokens-live` et
 * `paper-positions-live`. Pas de rejeu côté serveur : après toute reconnexion, `onReconnect` est appelé pour que
 * l'écran recharge ses listes. `EventSource` se reconnecte seul après une coupure réseau ; quand le serveur refuse
 * le flux (401, 429, 5xx), le navigateur abandonne : on relit alors la session (un 401 renvoie à la connexion) puis
 * on rouvre le flux avec un délai croissant (1 s → 30 s).
 */
export type BenchEventTopic = 'tokens' | 'paper' | 'jobs' | 'backtest';

/** Sous-ensemble d'`EventSource` utilisé ici (doublure dans les tests). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export const BENCH_EVENT_SOURCE = new InjectionToken<(url: string) => EventSourceLike>('BENCH_EVENT_SOURCE', {
  providedIn: 'root',
  factory: () => (url) => new EventSource(url) as unknown as EventSourceLike,
});

/** `EventSource.CLOSED` (constante dupliquée pour ne pas dépendre de l'objet global dans les tests). */
const CLOSED = 2;
export const SSE_RETRY_INITIAL_MS = 1_000;
export const SSE_RETRY_MAX_MS = 30_000;

export interface BenchEventHandlers {
  readonly onEvent: (event: BenchEvent) => void;
  /** Flux rouvert après une coupure : recharger les listes (événements manqués non rejoués). */
  readonly onReconnect?: () => void;
}

export interface BenchEventSubscription {
  close(): void;
}

export function eventsUrl(topics: readonly BenchEventTopic[]): string {
  return `${BENCH_SSE_PATH}?topics=${[...new Set(topics)].join(',')}`;
}

/** Message SSE → événement conforme au contrat, ou null (ignoré). */
export function parseBenchEvent(data: string): BenchEvent | null {
  try {
    const parsed = benchEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class BenchEvents {
  private readonly api = inject(BenchApi);
  private readonly createSource = inject(BENCH_EVENT_SOURCE);

  connect(topics: readonly BenchEventTopic[], handlers: BenchEventHandlers): BenchEventSubscription {
    const url = eventsUrl(topics);
    let source: EventSourceLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let interrupted = false;
    let delay = SSE_RETRY_INITIAL_MS;

    const open = (): void => {
      if (closed) return;
      const current = this.createSource(url);
      source = current;
      current.onopen = () => {
        delay = SSE_RETRY_INITIAL_MS;
        if (interrupted) {
          interrupted = false;
          handlers.onReconnect?.();
        }
      };
      current.onerror = () => {
        interrupted = true;
        // CONNECTING : le navigateur réessaie seul. CLOSED : refus du serveur, on reprend la main.
        if (current.readyState === CLOSED) {
          current.close();
          if (source === current) source = null;
          schedule();
        }
      };
      for (const type of BENCH_EVENT_TYPES) {
        current.addEventListener(type, (message) => {
          const event = parseBenchEvent(message.data);
          if (event !== null && !closed) handlers.onEvent(event);
        });
      }
    };

    const schedule = (): void => {
      if (closed || timer !== null) return;
      const wait = delay;
      delay = Math.min(delay * 2, SSE_RETRY_MAX_MS);
      timer = setTimeout(() => {
        timer = null;
        void this.api.get(BENCH_ROUTES.authSession).then(
          () => open(),
          (error: unknown) => {
            // 401 : AuthStore renvoie déjà à la connexion, inutile d'insister.
            if (isBenchApiError(error, 401)) closed = true;
            else schedule();
          },
        );
      }, wait);
    };

    open();
    return {
      close: () => {
        closed = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        source?.close();
        source = null;
      },
    };
  }
}
