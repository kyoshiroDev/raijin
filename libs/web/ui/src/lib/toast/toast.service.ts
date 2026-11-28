import { Injectable, signal } from '@angular/core';

export type RjToastTone = 'info' | 'success' | 'error';

export interface RjToast {
  readonly id: number;
  readonly message: string;
  readonly tone: RjToastTone;
}

export interface RjToastOptions {
  readonly tone?: RjToastTone;
  /** Durée d'affichage en ms (4 s par défaut, 0 = jusqu'à fermeture). */
  readonly duration?: number;
}

/** File de toasts (signals). Trois toasts au plus ; les plus anciens partent d'abord. */
@Injectable({ providedIn: 'root' })
export class RjToastService {
  private nextId = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly list = signal<readonly RjToast[]>([]);

  readonly toasts = this.list.asReadonly();

  show(message: string, options: RjToastOptions = {}): number {
    const id = this.nextId++;
    const toast: RjToast = { id, message, tone: options.tone ?? 'info' };
    const kept = this.list().slice(-2);
    for (const dropped of this.list().slice(0, -2)) {
      this.clearTimer(dropped.id);
    }
    this.list.set([...kept, toast]);
    const duration = options.duration ?? 4000;
    if (duration > 0) {
      this.timers.set(
        id,
        setTimeout(() => this.dismiss(id), duration),
      );
    }
    return id;
  }

  dismiss(id: number): void {
    this.clearTimer(id);
    this.list.update((list) => list.filter((toast) => toast.id !== id));
  }

  private clearTimer(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }
}
