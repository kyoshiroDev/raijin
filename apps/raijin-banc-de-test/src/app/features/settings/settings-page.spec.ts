import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { BehaviorSubject } from 'rxjs';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { describe, expect, it, vi } from 'vitest';
import { FakeBenchApi, provideFakeBench } from '../../core/api/bench-api.testing';
import { AuthStore } from '../../core/auth/auth-store';
import { BROWSER_SNAPSHOT, type BrowserSnapshot } from '../../core/pwa/push-environment';
import { SettingsPage } from './settings-page';

const ANDROID: BrowserSnapshot = {
  userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/131',
  platform: 'Linux armv8l',
  maxTouchPoints: 5,
  navigatorStandalone: undefined,
  displayModeStandalone: true,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: 'default',
};
const IPHONE_SAFARI: BrowserSnapshot = {
  ...ANDROID,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1',
  platform: 'iPhone',
  navigatorStandalone: false,
  displayModeStandalone: false,
  hasPushManager: false,
};

describe('SettingsPage', () => {
  async function setup(snapshot: BrowserSnapshot = ANDROID, mode: 'shadow' | 'primary' = 'primary') {
    const signOut = vi.fn(async () => undefined);
    const subscription$ = new BehaviorSubject<PushSubscription | null>(null);
    const requestSubscription = vi.fn(async () => {
      const endpoint = 'https://fcm.googleapis.com/fcm/send/x';
      const sub = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }) } as unknown as PushSubscription;
      subscription$.next(sub);
      return sub;
    });
    const api = new FakeBenchApi()
      .on('GET', BENCH_ROUTES.alertSettings, {})
      .on('GET', BENCH_ROUTES.pushVapidKey, { publicKey: 'B' + 'k'.repeat(86) })
      .on('POST', BENCH_ROUTES.pushSubscriptions, {})
      .on('PUT', BENCH_ROUTES.alertEnabled, {});
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthStore, useValue: { signOut, email: () => 'me@example.com', mode: () => mode } },
        ...provideFakeBench(api),
        { provide: SwPush, useValue: { isEnabled: true, subscription: subscription$, requestSubscription, unsubscribe: vi.fn() } },
        { provide: BROWSER_SNAPSHOT, useValue: () => snapshot },
      ],
    });
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    // API double: a few promise hops before the settings are loaded.
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const switchEl = () => el.querySelector<HTMLButtonElement>('button[role="switch"]');
    return { el, fixture, signOut, navigateByUrl, requestSubscription, switchEl };
  }

  it('links to the account page and shows the Notifications section', async () => {
    const { el, switchEl } = await setup();
    expect(el.querySelector('a[href="/account"]')).not.toBeNull();
    expect(el.textContent).toContain('me@example.com');
    const notif = el.querySelector('[data-section="notifications"]');
    expect(notif?.textContent).toContain('Notifications');
    expect(switchEl()?.getAttribute('aria-checked')).toBe('false');
    expect(el.querySelector('app-alert-settings-form')).not.toBeNull();
  });

  it('signs out and goes to /login', async () => {
    const { el, fixture, signOut, navigateByUrl } = await setup();
    const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Se déconnecter'));
    btn?.click();
    await fixture.whenStable();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(navigateByUrl).toHaveBeenCalledWith('/login');
  });

  it('requests the notification permission only when the switch is tapped', async () => {
    const { fixture, requestSubscription, switchEl } = await setup();
    expect(requestSubscription).not.toHaveBeenCalled();
    switchEl()?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(requestSubscription).toHaveBeenCalledTimes(1);
    expect(switchEl()?.getAttribute('aria-checked')).toBe('true');
  });

  it('shows the iPhone install guide and disables the switch in Safari', async () => {
    const { el, switchEl } = await setup(IPHONE_SAFARI);
    const guide = el.querySelector('[data-testid="ios-install-guide"]');
    expect(guide?.textContent).toContain('Partager');
    expect(guide?.textContent).toContain('Sur l’écran d’accueil');
    expect(switchEl()?.disabled).toBe(true);
  });

  it('hides the install guide outside iOS', async () => {
    const { el } = await setup();
    expect(el.querySelector('[data-testid="ios-install-guide"]')).toBeNull();
  });

  it('explains how to re-enable a denied permission', async () => {
    const { el, switchEl } = await setup({ ...ANDROID, permission: 'denied' });
    expect(el.querySelector('[data-testid="push-denied"]')?.textContent).toContain('Réglages iOS → Banc test → Notifications');
    expect(switchEl()?.disabled).toBe(true);
  });

  it('disables the test button while notifications are off', async () => {
    const { el } = await setup();
    const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Envoyer une notification de test'));
    expect(btn?.disabled).toBe(true);
  });

  it('says that no notification leaves the bench in shadow mode', async () => {
    const shadow = await setup(ANDROID, 'shadow');
    expect(shadow.el.querySelector('[data-shadow-mode]')?.textContent).toContain('mode ombre');
    TestBed.resetTestingModule();
    const primary = await setup(ANDROID, 'primary');
    expect(primary.el.querySelector('[data-shadow-mode]')).toBeNull();
  });
});
