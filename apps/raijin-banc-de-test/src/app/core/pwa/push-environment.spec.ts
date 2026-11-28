import { describe, expect, it } from 'vitest';
import { isIosDevice, isStandalone, needsIosInstall, pushCapability, type BrowserSnapshot } from './push-environment';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const snap = (over: Partial<BrowserSnapshot>): BrowserSnapshot => ({
  userAgent: WINDOWS_CHROME,
  platform: 'Win32',
  maxTouchPoints: 0,
  navigatorStandalone: undefined,
  displayModeStandalone: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: 'default',
  ...over,
});

const iphoneBrowser = snap({
  userAgent: IPHONE_SAFARI,
  platform: 'iPhone',
  maxTouchPoints: 5,
  navigatorStandalone: false,
  hasPushManager: false,
  hasNotification: false,
  permission: 'unsupported',
});
const iphoneInstalled = snap({ userAgent: IPHONE_SAFARI, platform: 'iPhone', maxTouchPoints: 5, navigatorStandalone: true });
const ipadOs = snap({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 5, navigatorStandalone: false });
const android = snap({ userAgent: ANDROID_CHROME, platform: 'Linux armv8l', maxTouchPoints: 5 });
const desktopMac = snap({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0, navigatorStandalone: false });
const desktopWin = snap({});

describe('iOS install detection', () => {
  it('iPhone Safari in the browser needs the home screen install', () => {
    expect(isIosDevice(iphoneBrowser)).toBe(true);
    expect(isStandalone(iphoneBrowser)).toBe(false);
    expect(needsIosInstall(iphoneBrowser)).toBe(true);
    expect(pushCapability(iphoneBrowser)).toBe('ios-install');
  });

  it('iPhone launched from the home screen is ready (navigator.standalone or display-mode)', () => {
    expect(needsIosInstall(iphoneInstalled)).toBe(false);
    expect(pushCapability(iphoneInstalled)).toBe('available');
    const viaDisplayMode = { ...iphoneInstalled, navigatorStandalone: undefined, displayModeStandalone: true };
    expect(needsIosInstall(viaDisplayMode)).toBe(false);
  });

  it('detects iPadOS (desktop-class UA with touch)', () => {
    expect(isIosDevice(ipadOs)).toBe(true);
    expect(needsIosInstall(ipadOs)).toBe(true);
  });

  it('Android and desktop never see the iOS guide', () => {
    for (const s of [android, desktopMac, desktopWin]) {
      expect(needsIosInstall(s)).toBe(false);
      expect(pushCapability(s)).toBe('available');
    }
  });
});

describe('pushCapability', () => {
  it('reports unsupported without service worker, PushManager or Notification', () => {
    expect(pushCapability(snap({ hasServiceWorker: false }))).toBe('unsupported');
    expect(pushCapability(snap({ hasPushManager: false }))).toBe('unsupported');
    expect(pushCapability(snap({ hasNotification: false, permission: 'unsupported' }))).toBe('unsupported');
  });

  it('reports a denied permission', () => {
    expect(pushCapability(snap({ permission: 'denied' }))).toBe('denied');
    expect(pushCapability({ ...iphoneInstalled, permission: 'denied' })).toBe('denied');
  });

  it('granted or default permission is available', () => {
    expect(pushCapability(snap({ permission: 'granted' }))).toBe('available');
    expect(pushCapability(snap({ permission: 'default' }))).toBe('available');
  });
});
