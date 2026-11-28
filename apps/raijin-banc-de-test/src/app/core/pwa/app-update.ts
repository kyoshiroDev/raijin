import { DOCUMENT, DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate, type VersionEvent, type VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/** Full page reload (a token so tests can observe it; jsdom's location.reload is not mockable). */
export const PAGE_RELOAD = new InjectionToken<() => void>('PAGE_RELOAD', {
  providedIn: 'root',
  factory: () => {
    const document = inject(DOCUMENT);
    return () => document.location.reload();
  },
});

/**
 * Service worker updates: exposes `updateReady` when a new version has been downloaded
 * (VERSION_READY) and reloads on an unrecoverable SW state (cached files no longer on the server).
 * Instantiated at bootstrap (provideAppInitializer in app.config.ts).
 */
@Injectable({ providedIn: 'root' })
export class AppUpdate {
  private readonly swUpdate = inject(SwUpdate);
  private readonly reloadPage = inject(PAGE_RELOAD);

  private readonly _updateReady = signal(false);
  private readonly _reloading = signal(false);
  readonly updateReady = this._updateReady.asReadonly();
  readonly reloading = this._reloading.asReadonly();

  constructor() {
    if (!this.swUpdate.isEnabled) return;
    const destroyRef = inject(DestroyRef);
    this.swUpdate.versionUpdates
      .pipe(
        filter((e: VersionEvent): e is VersionReadyEvent => e.type === 'VERSION_READY'),
        takeUntilDestroyed(destroyRef),
      )
      .subscribe(() => this._updateReady.set(true));
    this.swUpdate.unrecoverable.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.reloadPage());
  }

  /** « Recharger » : switch this tab to the new version, then reload to load its files. */
  async reload(): Promise<void> {
    if (this._reloading()) return;
    this._reloading.set(true);
    try {
      await this.swUpdate.activateUpdate();
    } catch {
      // Reload anyway: the browser fetches the new version on the next navigation.
    }
    this.reloadPage();
  }

  dismiss(): void {
    this._updateReady.set(false);
  }
}
