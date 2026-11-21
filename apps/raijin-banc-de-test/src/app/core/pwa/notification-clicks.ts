import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { notificationUrl, safeNotificationPath } from './notification-url';

/**
 * Routes notification clicks while the app is open (SwPush.notificationClicks).
 * When the app is closed, ngsw opens `data.onActionClick.default.url` itself
 * (operation `navigateLastFocusedOrOpen`, see docs/ARCHITECTURE.md « Notifications push »).
 * Instantiated at bootstrap (provideAppInitializer in app.config.ts).
 */
@Injectable({ providedIn: 'root' })
export class NotificationClicks {
  private readonly router = inject(Router);
  private readonly swPush = inject(SwPush);

  constructor() {
    if (!this.swPush.isEnabled) return;
    this.swPush.notificationClicks
      .pipe(takeUntilDestroyed(inject(DestroyRef)))
      .subscribe(({ notification }) => {
        void this.router.navigateByUrl(safeNotificationPath(notificationUrl(notification)));
      });
  }
}
