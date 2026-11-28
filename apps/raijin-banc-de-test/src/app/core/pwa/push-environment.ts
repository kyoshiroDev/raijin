import { InjectionToken } from '@angular/core';

/** What the browser offers for Web Push, read at a given moment (pure data, easy to fake in tests). */
export interface BrowserSnapshot {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** Safari's non-standard `navigator.standalone` (undefined elsewhere). */
  navigatorStandalone: boolean | undefined;
  /** `matchMedia('(display-mode: standalone)').matches` */
  displayModeStandalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: NotificationPermission | 'unsupported';
}

export type PushCapability = 'ios-install' | 'unsupported' | 'denied' | 'available';

/** iPhone / iPod / iPad, including iPadOS which reports itself as a Mac with a touch screen. */
export function isIosDevice(s: Pick<BrowserSnapshot, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  if (/iPhone|iPad|iPod/.test(s.userAgent)) return true;
  return s.platform === 'MacIntel' && s.maxTouchPoints > 1;
}

/** Launched from the home screen icon (installed web app). */
export function isStandalone(s: Pick<BrowserSnapshot, 'navigatorStandalone' | 'displayModeStandalone'>): boolean {
  return s.navigatorStandalone === true || s.displayModeStandalone;
}

/** iOS only delivers Web Push to web apps added to the home screen (iOS 16.4+). */
export function needsIosInstall(s: BrowserSnapshot): boolean {
  return isIosDevice(s) && !isStandalone(s);
}

export function pushCapability(s: BrowserSnapshot): PushCapability {
  if (needsIosInstall(s)) return 'ios-install';
  if (!s.hasServiceWorker || !s.hasPushManager || !s.hasNotification) return 'unsupported';
  if (s.permission === 'denied') return 'denied';
  return 'available';
}

export function readBrowserSnapshot(): BrowserSnapshot {
  const nav: (Navigator & { standalone?: unknown }) | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  const win: Window | undefined = typeof window === 'undefined' ? undefined : window;
  const hasNotification = !!win && 'Notification' in win;
  return {
    userAgent: nav?.userAgent ?? '',
    platform: nav?.platform ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    navigatorStandalone: typeof nav?.standalone === 'boolean' ? nav.standalone : undefined,
    displayModeStandalone: typeof win?.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches,
    hasServiceWorker: !!nav && 'serviceWorker' in nav,
    hasPushManager: !!win && 'PushManager' in win,
    hasNotification,
    permission: hasNotification ? Notification.permission : 'unsupported',
  };
}

/** Reads the current browser state. Overridden in tests. */
export const BROWSER_SNAPSHOT = new InjectionToken<() => BrowserSnapshot>('BROWSER_SNAPSHOT', {
  providedIn: 'root',
  factory: () => readBrowserSnapshot,
});
