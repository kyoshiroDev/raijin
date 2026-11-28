// Doublures de test du client du banc (jamais importées par le code de l'application).
import type { Provider } from '@angular/core';
import type { BenchErrorCode, BenchEvent, BenchRoute } from '@raijin/bench-contracts';
import { BenchApi, BenchApiError, type BenchRequestOptions } from './bench-api';
import { BenchEvents, type BenchEventHandlers, type BenchEventTopic } from './bench-events';

export type FakeMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RecordedCall {
  readonly method: FakeMethod;
  readonly route: BenchRoute;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
  readonly signal: AbortSignal | undefined;
}

/** Réponse : une valeur, une promesse, ou une fonction de l'appel ; lever (ou rejeter) une `BenchApiError` simule un échec. */
export type FakeResponder = ((call: RecordedCall) => unknown) | { readonly value: unknown };

export function apiError(status: number, code: BenchErrorCode | null = null, message = 'Erreur simulée.'): BenchApiError {
  return new BenchApiError(status, code, message);
}

/** `{ items, truncated }` comme les listes de l'API. */
export function list(items: readonly unknown[], truncated = false): { items: unknown[]; truncated: boolean } {
  return { items: [...items], truncated };
}

/**
 * Doublure de `BenchApi` : réponses par méthode et route, appels enregistrés. Une route sans réponse renvoie
 * 404 `NOT_FOUND` (comme une route absente de l'API).
 */
export class FakeBenchApi {
  readonly calls: RecordedCall[] = [];
  private readonly responders = new Map<string, FakeResponder>();

  on(method: FakeMethod, route: BenchRoute, responder: (call: RecordedCall) => unknown): this;
  on(method: FakeMethod, route: BenchRoute, value: unknown): this;
  on(method: FakeMethod, route: BenchRoute, responder: unknown): this {
    const isResponder = typeof responder === 'function' || (typeof responder === 'object' && responder !== null && 'value' in responder);
    this.responders.set(`${method} ${route}`, isResponder ? (responder as FakeResponder) : { value: responder });
    return this;
  }

  callsTo(method: FakeMethod, route: BenchRoute): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && c.route === route);
  }

  onUnauthorized(): void {
    // Rien : les tests du 401 passent par la vraie BenchApi (bench-api.spec.ts).
  }

  get<T = unknown>(route: BenchRoute, options: BenchRequestOptions = {}): Promise<T> {
    return this.handle<T>('GET', route, undefined, options);
  }

  post<T = unknown>(route: BenchRoute, body?: unknown, options: BenchRequestOptions = {}): Promise<T> {
    return this.handle<T>('POST', route, body, options);
  }

  put<T = unknown>(route: BenchRoute, body?: unknown, options: BenchRequestOptions = {}): Promise<T> {
    return this.handle<T>('PUT', route, body, options);
  }

  delete<T = unknown>(route: BenchRoute, body?: unknown, options: BenchRequestOptions = {}): Promise<T> {
    return this.handle<T>('DELETE', route, body, options);
  }

  private async handle<T>(method: FakeMethod, route: BenchRoute, body: unknown, options: BenchRequestOptions): Promise<T> {
    const call: RecordedCall = {
      method,
      route,
      params: options.params ?? {},
      query: (options.query ?? {}) as Record<string, unknown>,
      body,
      signal: options.signal,
    };
    this.calls.push(call);
    const responder = this.responders.get(`${method} ${route}`);
    if (!responder) throw apiError(404, 'NOT_FOUND', 'Route absente.');
    const value = typeof responder === 'function' ? responder(call) : responder.value;
    return (await value) as T;
  }
}

/** Doublure de `BenchEvents` : enregistre les abonnements, `emit` et `reconnect` simulent le flux. */
export class FakeBenchEvents {
  readonly subscriptions: { topics: readonly BenchEventTopic[]; handlers: BenchEventHandlers; closed: boolean }[] = [];

  connect(topics: readonly BenchEventTopic[], handlers: BenchEventHandlers): { close(): void } {
    const sub = { topics, handlers, closed: false };
    this.subscriptions.push(sub);
    return {
      close: () => {
        sub.closed = true;
      },
    };
  }

  get open(): number {
    return this.subscriptions.filter((s) => !s.closed).length;
  }

  emit(event: BenchEvent): void {
    for (const s of this.subscriptions) if (!s.closed) s.handlers.onEvent(event);
  }

  reconnect(): void {
    for (const s of this.subscriptions) if (!s.closed) s.handlers.onReconnect?.();
  }
}

export function provideFakeBench(api: FakeBenchApi, events: FakeBenchEvents = new FakeBenchEvents()): Provider[] {
  return [
    { provide: BenchApi, useValue: api },
    { provide: BenchEvents, useValue: events },
  ];
}
