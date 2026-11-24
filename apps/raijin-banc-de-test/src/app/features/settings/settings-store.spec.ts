import { TestBed } from '@angular/core/testing';
import { SwPush } from '@angular/service-worker';
import { BENCH_ROUTES, type BenchRoute } from '@raijin/bench-contracts';
import { BehaviorSubject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBenchApi, apiError, provideFakeBench, type FakeMethod } from '../../core/api/bench-api.testing';
import { BROWSER_SNAPSHOT, type BrowserSnapshot } from '../../core/pwa/push-environment';
import { UserPreferences } from '../../core/preferences/user-preferences';
import { DEFAULT_ALERT_SETTINGS, preferencesOf } from './alert-settings';
import { MSG, SettingsStore } from './settings-store';

const ENDPOINT = 'https://web.push.apple.com/QGx0c3Q';
const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);
const VAPID = 'B' + 'k'.repeat(86);
const fakeSubscription = (endpoint = ENDPOINT) =>
  ({ endpoint, toJSON: () => ({ endpoint, keys: { p256dh: P256DH, auth: AUTH } }) }) as unknown as PushSubscription;

const AVAILABLE: BrowserSnapshot = {
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

describe('SettingsStore', () => {
  let api: FakeBenchApi;
  /** Answers by `METHOD route`: a value, or an error thrown (API failure). Default: `{}`. */
  let answers: Map<string, unknown>;
  let snapshot: BrowserSnapshot;
  let subscription$: BehaviorSubject<PushSubscription | null>;
  let swPush: {
    isEnabled: boolean;
    subscription: BehaviorSubject<PushSubscription | null>;
    requestSubscription: ReturnType<typeof vi.fn<(o: { serverPublicKey: string }) => Promise<PushSubscription>>>;
    unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };

  const answer = (method: FakeMethod, route: BenchRoute, value: unknown) => answers.set(`${method} ${route}`, value);
  const callsOf = (method: FakeMethod, route: BenchRoute) => api.callsTo(method, route);
  const writes = () => api.calls.filter((c) => c.method !== 'GET');

  function setup(): SettingsStore {
    api = new FakeBenchApi();
    const routes: [FakeMethod, BenchRoute][] = [
      ['GET', BENCH_ROUTES.alertSettings],
      ['PUT', BENCH_ROUTES.alertSettings],
      ['PUT', BENCH_ROUTES.alertEnabled],
      ['GET', BENCH_ROUTES.pushVapidKey],
      ['POST', BENCH_ROUTES.pushSubscriptions],
      ['POST', BENCH_ROUTES.pushUnsubscribe],
      ['POST', BENCH_ROUTES.pushTest],
    ];
    for (const [method, route] of routes) {
      api.on(method, route, () => {
        const value = answers.get(`${method} ${route}`) ?? {};
        if (value instanceof Error) throw value;
        return value;
      });
    }
    TestBed.configureTestingModule({
      providers: [
        SettingsStore,
        ...provideFakeBench(api),
        { provide: SwPush, useValue: swPush },
        { provide: BROWSER_SNAPSHOT, useValue: () => snapshot },
      ],
    });
    return TestBed.inject(SettingsStore);
  }

  beforeEach(() => {
    answers = new Map();
    answer('GET', BENCH_ROUTES.alertSettings, { ...DEFAULT_ALERT_SETTINGS });
    answer('GET', BENCH_ROUTES.pushVapidKey, { publicKey: VAPID });
    answer('POST', BENCH_ROUTES.pushTest, { sent: 1, failed: 0 });
    snapshot = { ...AVAILABLE };
    subscription$ = new BehaviorSubject<PushSubscription | null>(null);
    swPush = {
      isEnabled: true,
      subscription: subscription$,
      requestSubscription: vi.fn(async () => {
        const sub = fakeSubscription();
        subscription$.next(sub);
        return sub;
      }),
      unsubscribe: vi.fn(async () => subscription$.next(null)),
    };
  });

  describe('notification switch', () => {
    it('never requests the permission on load', async () => {
      answer('GET', BENCH_ROUTES.alertSettings, { ...DEFAULT_ALERT_SETTINGS, max_per_hour: 8 });
      const store = setup();
      await store.load();
      expect(swPush.requestSubscription).not.toHaveBeenCalled();
      expect(store.settings().max_per_hour).toBe(8);
      expect(store.status()).toBe('off');
    });

    it('reads the bench VAPID key, subscribes on tap, registers the subscription, then enables alerts', async () => {
      const store = setup();
      await store.load();
      await store.toggle();
      expect(callsOf('GET', BENCH_ROUTES.pushVapidKey)).toHaveLength(1);
      expect(swPush.requestSubscription).toHaveBeenCalledExactlyOnceWith({ serverPublicKey: VAPID });
      const [sub] = callsOf('POST', BENCH_ROUTES.pushSubscriptions);
      expect(sub?.body).toEqual({ endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } });
      expect(callsOf('PUT', BENCH_ROUTES.alertEnabled)[0]?.body).toEqual({ enabled: true });
      expect(store.status()).toBe('on');
      expect(store.pushMessage()).toBeNull();
    });

    it('shows the denied state when the permission is refused', async () => {
      swPush.requestSubscription.mockImplementation(async () => {
        snapshot = { ...snapshot, permission: 'denied' };
        throw new DOMException('denied', 'NotAllowedError');
      });
      const store = setup();
      await store.toggle();
      expect(store.status()).toBe('denied');
      expect(store.pushMessage()?.text).toBe(MSG.denied);
      expect(writes()).toEqual([]);
    });

    it('is already denied when the browser says so', () => {
      snapshot = { ...snapshot, permission: 'denied' };
      expect(setup().status()).toBe('denied');
    });

    it('does not ask the permission when the bench has no VAPID key (push not configured)', async () => {
      answer('GET', BENCH_ROUTES.pushVapidKey, apiError(503));
      const store = setup();
      await store.toggle();
      expect(swPush.requestSubscription).not.toHaveBeenCalled();
      expect(store.pushMessage()?.text).toBe(MSG.enableFailed);
      expect(writes()).toEqual([]);
    });

    it('does not enable alerts when the subscription is refused', async () => {
      answer('POST', BENCH_ROUTES.pushSubscriptions, apiError(400, 'VALIDATION_ERROR'));
      const store = setup();
      await store.toggle();
      expect(store.pushMessage()?.text).toBe(MSG.enableFailed);
      expect(callsOf('PUT', BENCH_ROUTES.alertEnabled)).toEqual([]);
      expect(store.status()).toBe('off');
    });

    it('reports the 10-device cap (409)', async () => {
      answer('POST', BENCH_ROUTES.pushSubscriptions, apiError(409, 'CONFLICT'));
      const store = setup();
      await store.toggle();
      expect(store.pushMessage()?.text).toBe(MSG.tooMany);
      expect(swPush.unsubscribe).not.toHaveBeenCalled();
    });

    it('unsubscribes, forgets this endpoint and disables alerts', async () => {
      answer('GET', BENCH_ROUTES.alertSettings, { ...DEFAULT_ALERT_SETTINGS, enabled: true });
      subscription$.next(fakeSubscription());
      const store = setup();
      await store.load();
      expect(store.status()).toBe('on');
      api.calls.length = 0;
      await store.toggle();
      expect(swPush.unsubscribe).toHaveBeenCalledTimes(1);
      expect(swPush.requestSubscription).not.toHaveBeenCalled();
      expect(callsOf('POST', BENCH_ROUTES.pushUnsubscribe).map((c) => c.body)).toEqual([{ endpoint: ENDPOINT }]);
      expect(callsOf('PUT', BENCH_ROUTES.alertEnabled)[0]?.body).toEqual({ enabled: false });
      expect(store.status()).toBe('off');
    });

    it('re-registers the current subscription on load when enabled (no permission prompt)', async () => {
      answer('GET', BENCH_ROUTES.alertSettings, { ...DEFAULT_ALERT_SETTINGS, enabled: true });
      subscription$.next(fakeSubscription());
      const store = setup();
      await store.load();
      await Promise.resolve();
      expect(callsOf('POST', BENCH_ROUTES.pushSubscriptions)).toHaveLength(1);
      expect(swPush.requestSubscription).not.toHaveBeenCalled();
    });

    it('iPhone Safari not installed: ios-install state, tapping does nothing', async () => {
      snapshot = {
        ...AVAILABLE,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1',
        platform: 'iPhone',
        navigatorStandalone: false,
        displayModeStandalone: false,
        hasPushManager: false,
      };
      const store = setup();
      expect(store.status()).toBe('ios-install');
      await store.toggle();
      expect(swPush.requestSubscription).not.toHaveBeenCalled();
    });

    it('is unsupported when the service worker is disabled', async () => {
      swPush.isEnabled = false;
      const store = setup();
      expect(store.status()).toBe('unsupported');
      await store.enable();
      expect(swPush.requestSubscription).not.toHaveBeenCalled();
    });
  });

  describe('alert preferences', () => {
    const BASE = preferencesOf(DEFAULT_ALERT_SETTINGS);

    it('saves exactly the editable columns with PUT /api/settings/alerts (never enabled, never an archived column)', async () => {
      const store = setup();
      expect(await store.savePreferences({ ...BASE, quiet_start: 22, max_per_hour: 6 })).toEqual({});
      const [call] = callsOf('PUT', BENCH_ROUTES.alertSettings);
      expect(call?.body).toEqual({
        hide_bonding_curve: true,
        quiet_start: 22,
        quiet_end: 7,
        max_per_hour: 6,
        max_per_day: 30,
        stake_sol: 0.05,
        auto_paper: false,
        paper_sl_pct: 30,
      });
      expect(store.settings().max_per_hour).toBe(6);
      expect(store.saveMessage()).toEqual({ kind: 'ok', text: MSG.saved });
    });

    it('keeps only the live columns on load (one read, archived columns ignored)', async () => {
      answer('GET', BENCH_ROUTES.alertSettings, { ...DEFAULT_ALERT_SETTINGS, max_per_day: 12, min_score: 90, alert_preset: 'strict' });
      const store = setup();
      await store.load();
      expect(callsOf('GET', BENCH_ROUTES.alertSettings)).toHaveLength(1);
      expect(store.settings()).toEqual({ ...DEFAULT_ALERT_SETTINGS, max_per_day: 12 });
    });

    it('reports a load error', async () => {
      answer('GET', BENCH_ROUTES.alertSettings, apiError(500));
      const store = setup();
      await store.load();
      expect(store.loadError()).toBe(MSG.loadFailed);
      expect(store.loaded()).toBe(true);
    });

    it('saves the auto-paper switch with the preferences (never enabled) and loads it', async () => {
      answer('GET', BENCH_ROUTES.alertSettings, { ...DEFAULT_ALERT_SETTINGS, auto_paper: true });
      const store = setup();
      await store.load();
      expect(store.settings().auto_paper).toBe(true);
      expect(await store.savePreferences({ ...BASE, auto_paper: false })).toEqual({});
      const [call] = callsOf('PUT', BENCH_ROUTES.alertSettings);
      expect(call?.body).toMatchObject({ auto_paper: false });
      expect(call?.body).not.toHaveProperty('enabled');
      expect(store.settings().auto_paper).toBe(false);
    });

    it('saves the default paper stop and shares it with the paper trade sheet (UserPreferences)', async () => {
      answer('GET', BENCH_ROUTES.alertSettings, { ...DEFAULT_ALERT_SETTINGS, paper_sl_pct: 40 });
      const store = setup();
      await store.load();
      const prefs = TestBed.inject(UserPreferences);
      expect(prefs.paperSlPct()).toBe(40);
      await store.savePreferences({ ...BASE, paper_sl_pct: 20 });
      expect(callsOf('PUT', BENCH_ROUTES.alertSettings)[0]?.body).toMatchObject({ paper_sl_pct: 20 });
      expect(callsOf('PUT', BENCH_ROUTES.alertSettings)[0]?.body).not.toHaveProperty('paper_default_strategy');
      expect(prefs.paperSlPct()).toBe(20);
    });

    it('refuses an out-of-range default stop without calling the API', async () => {
      const store = setup();
      const errors = await store.savePreferences({ ...BASE, paper_sl_pct: 0 });
      expect(errors.paper_sl_pct).toBeDefined();
      expect(callsOf('PUT', BENCH_ROUTES.alertSettings)).toEqual([]);
    });

    it('includes stake_sol in the body and shares it with the opportunities (UserPreferences)', async () => {
      const store = setup();
      expect(await store.savePreferences({ ...BASE, stake_sol: 0.25 })).toEqual({});
      const [call] = callsOf('PUT', BENCH_ROUTES.alertSettings);
      expect((call?.body as { stake_sol: number }).stake_sol).toBe(0.25);
      expect(Object.keys(call?.body as object)).not.toContain('enabled');
      expect(Object.keys(call?.body as object)).not.toContain('user_id');
      expect(store.settings().stake_sol).toBe(0.25);
      expect(TestBed.inject(UserPreferences).stakeSol()).toBe(0.25);
    });

    it('refuses an out-of-range stake without calling the API', async () => {
      const store = setup();
      for (const stake_sol of [0.005, 101]) {
        const errors = await store.savePreferences({ ...BASE, stake_sol });
        expect(Object.keys(errors)).toEqual(['stake_sol']);
      }
      expect(callsOf('PUT', BENCH_ROUTES.alertSettings)).toEqual([]);
      expect(TestBed.inject(UserPreferences).stakeSol()).toBe(0.05);
    });

    it('reads stake_sol on load and shares the stored stake', async () => {
      answer('GET', BENCH_ROUTES.alertSettings, { ...DEFAULT_ALERT_SETTINGS, stake_sol: 1.5 });
      const store = setup();
      await store.load();
      expect(store.settings().stake_sol).toBe(1.5);
      expect(TestBed.inject(UserPreferences).stakeSol()).toBe(1.5);
    });

    it('refuses invalid values without calling the API', async () => {
      const store = setup();
      const errors = await store.savePreferences({ ...BASE, max_per_hour: 50 });
      expect(Object.keys(errors)).toEqual(['max_per_hour']);
      expect(callsOf('PUT', BENCH_ROUTES.alertSettings)).toEqual([]);
    });

    it('reports a save failure (a single attempt)', async () => {
      answer('PUT', BENCH_ROUTES.alertSettings, apiError(400, 'VALIDATION_ERROR'));
      const store = setup();
      await store.savePreferences(BASE);
      expect(callsOf('PUT', BENCH_ROUTES.alertSettings)).toHaveLength(1);
      expect(store.saveMessage()).toEqual({ kind: 'error', text: MSG.saveFailed });
    });
  });

  describe('test notification', () => {
    async function enabledStore(): Promise<SettingsStore> {
      answer('GET', BENCH_ROUTES.alertSettings, { ...DEFAULT_ALERT_SETTINGS, enabled: true });
      subscription$.next(fakeSubscription());
      const store = setup();
      await store.load();
      return store;
    }

    it('is disabled while notifications are off', async () => {
      const store = setup();
      await store.load();
      expect(store.canSendTest()).toBe(false);
      await store.sendTest();
      expect(callsOf('POST', BENCH_ROUTES.pushTest)).toEqual([]);
    });

    it('reports the number of devices', async () => {
      answer('POST', BENCH_ROUTES.pushTest, { sent: 2, failed: 0 });
      const store = await enabledStore();
      const pending = store.sendTest();
      expect(store.testState()).toBe('pending');
      expect(store.canSendTest()).toBe(false);
      await pending;
      expect(callsOf('POST', BENCH_ROUTES.pushTest)).toHaveLength(1);
      expect(store.testState()).toBe('sent');
      expect(store.testSent()).toBe(2);
    });

    it('maps a 429 to « throttled »', async () => {
      answer('POST', BENCH_ROUTES.pushTest, apiError(429, 'RATE_LIMITED'));
      const store = await enabledStore();
      await store.sendTest();
      expect(store.testState()).toBe('throttled');
    });

    it('maps other failures to « error »', async () => {
      answer('POST', BENCH_ROUTES.pushTest, apiError(503));
      const store = await enabledStore();
      await store.sendTest();
      expect(store.testState()).toBe('error');
      answer('POST', BENCH_ROUTES.pushTest, apiError(403, 'BENCH_SHADOW_MODE'));
      await store.sendTest();
      expect(store.testState()).toBe('error');
    });
  });
});
