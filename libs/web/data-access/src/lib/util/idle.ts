import { DOCUMENT } from '@angular/common';
import { Injector, afterNextRender, inject } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationSkipped, Router } from '@angular/router';
import { filter, take } from 'rxjs';

/** Délai maximal avant d'exécuter quand même une tâche d'appoint (navigateur jamais inactif). */
const IDLE_TIMEOUT_MS = 2000;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};

/**
 * Exécute `task` quand le navigateur est inactif (`requestIdleCallback`, repli `setTimeout`).
 * Sert à sortir du chemin critique ce qui ne sert pas le premier affichage.
 */
export function runWhenIdle(task: () => void, view: Window | null = globalThis.window ?? null): void {
  const win = view as IdleWindow | null;
  if (win?.requestIdleCallback) {
    win.requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
  } else {
    setTimeout(task, 1);
  }
}

/**
 * Exécute `task` après le premier rendu de la **route** (fin de la navigation initiale, puis rendu,
 * puis inactivité du navigateur) : session, attribution, quota et préchargement des contrats ne
 * concurrencent jamais l'élément LCP (docs/ARCHITECTURE.md §10.2, point 5).
 * À appeler dans un contexte d'injection (initialiseur d'app, constructeur).
 */
export function runAfterFirstRoute(task: () => void): void {
  const router = inject(Router);
  const injector = inject(Injector);
  const view = inject(DOCUMENT).defaultView;
  router.events
    .pipe(
      filter(
        (event) =>
          event instanceof NavigationEnd ||
          event instanceof NavigationCancel ||
          event instanceof NavigationError ||
          event instanceof NavigationSkipped,
      ),
      take(1),
    )
    .subscribe(() => afterNextRender(() => runWhenIdle(task, view), { injector }));
}

/**
 * Exécute `task` après le prochain rendu puis à l'inactivité du navigateur (tâches d'appoint
 * d'un écran déjà affiché, ex. le quota). À appeler dans un contexte d'injection.
 */
export function runAfterRenderWhenIdle(task: () => void): void {
  const view = inject(DOCUMENT).defaultView;
  afterNextRender(() => runWhenIdle(task, view));
}

/**
 * Rend la main au navigateur (nouvelle tâche) : sépare le premier rendu de l'app et celui du verdict, pour
 * qu'aucun des deux ne forme une tâche longue (TBT, docs/ARCHITECTURE.md §10.6).
 */
export function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
