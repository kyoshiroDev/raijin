import { DestroyRef, computed, inject, signal } from '@angular/core';

/**
 * Délai avant un nouvel envoi d'e-mail (« Renvoyer » désactivé pendant `seconds`).
 * À créer dans un contexte d'injection : le minuteur s'arrête avec le composant.
 */
export function createCooldown(seconds = 60) {
  const remaining = signal(0);
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  inject(DestroyRef).onDestroy(stop);
  return {
    remaining: remaining.asReadonly(),
    active: computed(() => remaining() > 0),
    start(): void {
      stop();
      remaining.set(seconds);
      timer = setInterval(() => {
        remaining.update((value) => Math.max(0, value - 1));
        if (remaining() === 0) stop();
      }, 1000);
    },
  };
}
