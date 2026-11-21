import { DestroyRef, inject, signal, type Signal } from '@angular/core';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_SECONDS = 30;

export interface AttemptLock {
  readonly failedAttempts: Signal<number>;
  /** Seconds left before the form is unlocked (0 = not locked). */
  readonly lockRemaining: Signal<number>;
  /** Records a failure; locks for `LOCK_SECONDS` after `MAX_FAILED_ATTEMPTS` failures. */
  fail(): void;
  /** Resets the failure counter (after a success). */
  reset(): void;
}

/**
 * Front-side brake on password guessing (the server keeps its own rate limits).
 * Must be called in an injection context: the countdown is cleared on destroy.
 */
export function createAttemptLock(): AttemptLock {
  const failedAttempts = signal(0);
  const lockRemaining = signal(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  inject(DestroyRef).onDestroy(stop);

  return {
    failedAttempts: failedAttempts.asReadonly(),
    lockRemaining: lockRemaining.asReadonly(),
    fail() {
      failedAttempts.update((n) => n + 1);
      if (failedAttempts() < MAX_FAILED_ATTEMPTS) return;
      stop();
      lockRemaining.set(LOCK_SECONDS);
      timer = setInterval(() => {
        const left = lockRemaining() - 1;
        lockRemaining.set(Math.max(0, left));
        if (left <= 0) {
          stop();
          failedAttempts.set(0);
        }
      }, 1000);
    },
    reset() {
      failedAttempts.set(0);
    },
  };
}
