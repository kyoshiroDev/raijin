import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';
import type { AnalysisResponse, AnalysisResult } from '@raijin/shared-contracts';
import { loadContracts } from '../contracts';

export type AnalysisValidationKind = 'response' | 'result';

export interface AnalysisValidationRequest {
  readonly id: number;
  readonly kind: AnalysisValidationKind;
  readonly body: unknown;
}

export type AnalysisValidationReply =
  | { readonly id: number; readonly ok: true; readonly data: unknown }
  | { readonly id: number; readonly ok: false };

/** Au-delà, la validation repasse sur le fil principal (worker bloqué ou lent). */
export const VALIDATION_WORKER_TIMEOUT_MS = 10_000;

interface Pending {
  resolve(value: unknown): void;
  fallback(): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Validation complète des analyses par les contrats, dans un Web Worker quand le navigateur le permet
 * (`analysis-validation.worker.ts`) : Zod n'est alors jamais évalué sur le fil principal des écrans d'analyse
 * (docs/ARCHITECTURE.md §10.6, TBT). Sans worker (tests, navigateur ancien, échec de chargement, délai dépassé),
 * ou si le worker rejette la réponse, la validation est faite sur le fil principal par `loadContracts()` : même
 * résultat, même erreur (`ZodError`) qu'avant.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisValidator {
  private readonly view = inject(DOCUMENT).defaultView;
  private worker: Worker | null | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  validateResponse(body: unknown): Promise<AnalysisResponse> {
    return this.run(body, 'response', async () => (await loadContracts()).analysisResponseSchema.parse(body));
  }

  validateResult(body: unknown): Promise<AnalysisResult> {
    return this.run(body, 'result', async () => (await loadContracts()).analysisResultSchema.parse(body));
  }

  private run<T>(body: unknown, kind: AnalysisValidationKind, onMainThread: () => Promise<T>): Promise<T> {
    const worker = this.ensureWorker();
    if (!worker) return onMainThread();
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const fallback = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        onMainThread().then(resolve, reject);
      };
      const timer = setTimeout(fallback, VALIDATION_WORKER_TIMEOUT_MS);
      this.pending.set(id, { resolve: (value) => resolve(value as T), fallback, timer });
      try {
        worker.postMessage({ id, kind, body } satisfies AnalysisValidationRequest);
      } catch {
        fallback();
      }
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker !== undefined) return this.worker;
    this.worker = null;
    if (!this.view || typeof this.view.Worker !== 'function') return null;
    try {
      const worker = new Worker(new URL('./analysis-validation.worker', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (event: MessageEvent<AnalysisValidationReply>) => this.onReply(event.data));
      worker.addEventListener('error', () => this.failWorker());
      worker.addEventListener('messageerror', () => this.failWorker());
      this.worker = worker;
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private onReply(reply: AnalysisValidationReply): void {
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    if (!reply.ok) {
      // Rejet : rejoué sur le fil principal pour remonter la même erreur qu'une validation directe.
      entry.fallback();
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(reply.id);
    entry.resolve(reply.data);
  }

  /** Worker inutilisable : toutes les validations en attente (et les suivantes) passent sur le fil principal. */
  private failWorker(): void {
    this.stop();
    this.worker = null;
  }

  private stop(): void {
    this.worker?.terminate();
    for (const entry of [...this.pending.values()]) entry.fallback();
  }
}
