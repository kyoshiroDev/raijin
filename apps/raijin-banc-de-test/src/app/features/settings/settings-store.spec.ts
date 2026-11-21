import { TestBed } from '@angular/core/testing';
import { SwPush } from '@angular/service-worker';
import { BehaviorSubject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_SNAPSHOT, type BrowserSnapshot } from '../../core/pwa/push-environment';
import { VAPID_PUBLIC_KEY } from '../../core/pwa/push-config';
import { UserPreferences } from '../../core/preferences/user-preferences';
import { SUPABASE } from '../../core/supabase/supabase-client';
import { ALERT_SETTINGS_COLUMNS, DEFAULT_ALERT_SETTINGS, preferencesOf } from './alert-settings';
import { MSG, SettingsStore } from './settings-store';

interface Result {
  data?: unknown;
  error: unknown;
}
interface Call {
  table: string;
  op: 'select' | 'upsert' | 'delete';
  payload?: unknown;
  options?: unknown;
  filter?: [string, unknown];
}

const ENDPOINT = 'https://web.push.apple.com/QGx0c3Q';
const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);
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
  let calls: Call[];
  let results: Map<string, Result>;
  /** Consumed before `results` by the next upserts (one entry each). */
  let upsertQueue: Result[];
  let invoke: ReturnType<typeof vi.fn<(name: string, options?: unknown) => Promise<Result>>>;
  let snapshot: BrowserSnapshot;
  let subscription$: BehaviorSubject<PushSubscription | null>;
  let swPush: {
    isEnabled: boolean;
    subscription: BehaviorSubject<PushSubscription | null>;
    requestSubscription: ReturnType<typeof vi.fn<(o: { serverPublicKey: string }) => Promise<PushSubscription>>>;
    unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };

  const res = (key: string): Result => results.get(key) ?? { data: null, error: null };
  const callsOf = (table: string, op: Call['op']) => calls.filter((c) => c.table === table && c.op === op);

  function setup(): SettingsStore {
    const client = {
      from: (table: string) => ({
        select: (columns: string) => ({
          maybeSingle: async () => {
            calls.push({ table, op: 'select', payload: columns });
            return results.get(`${table}.select:${columns}`) ?? res(`${table}.select`);
          },
        }),
        upsert: async (payload: unknown, options: unknown) => {
          calls.push({ table, op: 'upsert', payload, options });
          return upsertQueue.shift() ?? res(`${table}.upsert`);
        },
        delete: () => ({
          eq: async (column: string, value: unknown) => {
            calls.push({ table, op: 'delete', filter: [column, value] });
            return res(`${table}.delete`);
          },
        }),
      }),
      functions: { invoke },
    };
    TestBed.configureTestingModule({
      providers: [
        SettingsStore,
        { provide: SUPABASE, useValue: client },
        { provide: SwPush, useValue: swPush },
        { provide: VAPID_PUBLIC_KEY, useValue: 'BTestPublicKey' },
        { provide: BROWSER_SNAPSHOT, useValue: () => snapshot },
      ],
    });
    return TestBed.inject(SettingsStore);
  }

  beforeEach(() => {
    calls = [];
    results = new Map();
    upsertQueue = [];
    invoke = vi.fn(async () => ({ data: { sent: 1, removed: 0 }, error: null }));
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
      results.set('alert_settings.select', { data: { ...DEFAULT_ALERT_SETTINGS, max_per_hour: 8 }, error: null });
      const store = setup();
      await store.load();
      expect(swPush.requestSubscription).not.toHaveBeenCalled();
      expect(store.settings().max_per_hour).toBe(8);
      expect(store.status()).toBe('off');
    });

    it('subscribes on tap and upserts the right columns, then enables alerts', async () => {
      const store = setup();
      await store.load();
      await store.toggle();
      expect(swPush.requestSubscription).toHaveBeenCalledExactlyOnceWith({ serverPublicKey: 'BTestPublicKey' });
      const [sub] = callsOf('push_subscriptions', 'upsert');
      expect(sub.payload).toEqual({ endpoint: ENDPOINT, p256dh: P256DH, auth: AUTH, user_agent: navigator.userAgent.slice(0, 300) });
      expect(Object.keys(sub.payload as object)).not.toContain('user_id');
      expect(sub.options).toEqual({ onConflict: 'endpoint' });
      const [settings] = callsOf('alert_settings', 'upsert');
      expect(settings.payload).toEqual({ enabled: true });
      expect(settings.options).toEqual({ onConflict: 'user_id' });
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
      expect(calls.filter((c) => c.op !== 'select')).toEqual([]);
    });

    it('is already denied when the browser says so', () => {
      snapshot = { ...snapshot, permission: 'denied' };
      expect(setup().status()).toBe('denied');
    });

    it('handles an endpoint owned by another account: unlinks the device, explains, does not enable', async () => {
      results.set('push_subscriptions.upsert', { error: { code: '42501', message: 'new row violates row-level security policy' } });
      const store = setup();
      await store.toggle();
      expect(swPush.unsubscribe).toHaveBeenCalledTimes(1);
      expect(store.pushMessage()?.text).toContain('Cet appareil est déjà lié à un autre compte');
      expect(callsOf('alert_settings', 'upsert')).toEqual([]);
      expect(store.status()).toBe('off');
    });

    it('reports the 10-device cap', async () => {
      results.set('push_subscriptions.upsert', { error: { code: '23514', message: 'too many push subscriptions' } });
      const store = setup();
      await store.toggle();
      expect(store.pushMessage()?.text).toBe(MSG.tooMany);
      expect(swPush.unsubscribe).not.toHaveBeenCalled();
    });

    it('unsubscribes, deletes the row of this endpoint and disables alerts', async () => {
      results.set('alert_settings.select', { data: { ...DEFAULT_ALERT_SETTINGS, enabled: true }, error: null });
      subscription$.next(fakeSubscription());
      const store = setup();
      await store.load();
      expect(store.status()).toBe('on');
      calls = [];
      await store.toggle();
      expect(swPush.unsubscribe).toHaveBeenCalledTimes(1);
      expect(swPush.requestSubscription).not.toHaveBeenCalled();
      expect(callsOf('push_subscriptions', 'delete')).toEqual([{ table: 'push_subscriptions', op: 'delete', filter: ['endpoint', ENDPOINT] }]);
      expect(callsOf('alert_settings', 'upsert')[0]?.payload).toEqual({ enabled: false });
      expect(store.status()).toBe('off');
    });

    it('re-registers the current subscription on load when enabled (no permission prompt)', async () => {
      results.set('alert_settings.select', { data: { ...DEFAULT_ALERT_SETTINGS, enabled: true }, error: null });
      subscription$.next(fakeSubscription());
      const store = setup();
      await store.load();
      await Promise.resolve();
      expect(callsOf('push_subscriptions', 'upsert')).toHaveLength(1);
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

    it('upserts exactly the editable columns with alert_preset « young_calm » (never enabled, never an archived column)', async () => {
      const store = setup();
      expect(await store.savePreferences({ ...BASE, quiet_start: 22, max_per_hour: 6 })).toEqual({});
      const [call] = callsOf('alert_settings', 'upsert');
      expect(call.payload).toEqual({
        alert_preset: 'young_calm',
        hide_bonding_curve: true,
        quiet_start: 22,
        quiet_end: 7,
        max_per_hour: 6,
        max_per_day: 30,
        stake_sol: 0.05,
        auto_paper: false,
        paper_sl_pct: 30,
      });
      expect(call.options).toEqual({ onConflict: 'user_id' });
      expect(store.settings().max_per_hour).toBe(6);
      expect(store.saveMessage()).toEqual({ kind: 'ok', text: MSG.saved });
    });

    it('selects only the live columns on load (one read, no legacy fallback)', async () => {
      results.set('alert_settings.select', { data: { ...DEFAULT_ALERT_SETTINGS, max_per_day: 12, min_score: 90, alert_preset: 'strict' }, error: null });
      const store = setup();
      await store.load();
      expect(callsOf('alert_settings', 'select').map((c) => c.payload)).toEqual([ALERT_SETTINGS_COLUMNS]);
      expect(store.settings()).toEqual({ ...DEFAULT_ALERT_SETTINGS, max_per_day: 12 });
    });

    it('reports a load error', async () => {
      results.set('alert_settings.select', { data: null, error: { code: '500', message: 'x' } });
      const store = setup();
      await store.load();
      expect(store.loadError()).toBe(MSG.loadFailed);
      expect(store.loaded()).toBe(true);
    });

    it('saves the auto-paper switch with the alert-settings upsert (never enabled) and loads it', async () => {
      results.set('alert_settings.select', { data: { ...DEFAULT_ALERT_SETTINGS, auto_paper: true }, error: null });
      const store = setup();
      await store.load();
      expect(callsOf('alert_settings', 'select')[0]?.payload).toContain('auto_paper');
      expect(store.settings().auto_paper).toBe(true);
      expect(await store.savePreferences({ ...BASE, auto_paper: false })).toEqual({});
      const [call] = callsOf('alert_settings', 'upsert');
      expect(call.payload).toMatchObject({ auto_paper: false });
      expect(call.payload).not.toHaveProperty('enabled');
      expect(store.settings().auto_paper).toBe(false);
    });

    it('saves the default paper stop and shares it with the paper trade sheet (UserPreferences)', async () => {
      results.set('alert_settings.select', { data: { ...DEFAULT_ALERT_SETTINGS, paper_sl_pct: 40 }, error: null });
      const store = setup();
      await store.load();
      const prefs = TestBed.inject(UserPreferences);
      expect(prefs.paperSlPct()).toBe(40);
      await store.savePreferences({ ...BASE, paper_sl_pct: 20 });
      expect(callsOf('alert_settings', 'upsert')[0].payload).toMatchObject({ paper_sl_pct: 20 });
      expect(callsOf('alert_settings', 'upsert')[0].payload).not.toHaveProperty('paper_default_strategy');
      expect(prefs.paperSlPct()).toBe(20);
    });

    it('refuses an out-of-range default stop without calling the database', async () => {
      const store = setup();
      const errors = await store.savePreferences({ ...BASE, paper_sl_pct: 0 });
      expect(errors.paper_sl_pct).toBeDefined();
      expect(callsOf('alert_settings', 'upsert')).toEqual([]);
    });

    it('includes stake_sol in the upsert and shares it with the opportunities (UserPreferences)', async () => {
      const store = setup();
      expect(await store.savePreferences({ ...BASE, stake_sol: 0.25 })).toEqual({});
      const [call] = callsOf('alert_settings', 'upsert');
      expect((call.payload as { stake_sol: number }).stake_sol).toBe(0.25);
      expect(Object.keys(call.payload as object)).not.toContain('enabled');
      expect(Object.keys(call.payload as object)).not.toContain('user_id');
      expect(store.settings().stake_sol).toBe(0.25);
      expect(TestBed.inject(UserPreferences).stakeSol()).toBe(0.25);
    });

    it('refuses an out-of-range stake without calling the database', async () => {
      const store = setup();
      for (const stake_sol of [0.005, 101]) {
        const errors = await store.savePreferences({ ...BASE, stake_sol });
        expect(Object.keys(errors)).toEqual(['stake_sol']);
      }
      expect(callsOf('alert_settings', 'upsert')).toEqual([]);
      expect(TestBed.inject(UserPreferences).stakeSol()).toBe(0.05);
    });

    it('selects stake_sol on load and shares the stored stake', async () => {
      results.set('alert_settings.select', { data: { ...DEFAULT_ALERT_SETTINGS, stake_sol: 1.5 }, error: null });
      const store = setup();
      await store.load();
      expect(callsOf('alert_settings', 'select')[0]?.payload).toContain('stake_sol');
      expect(store.settings().stake_sol).toBe(1.5);
      expect(TestBed.inject(UserPreferences).stakeSol()).toBe(1.5);
    });

    it('refuses invalid values without calling the database', async () => {
      const store = setup();
      const errors = await store.savePreferences({ ...BASE, max_per_hour: 50 });
      expect(Object.keys(errors)).toEqual(['max_per_hour']);
      expect(callsOf('alert_settings', 'upsert')).toEqual([]);
    });

    it('reports a save failure (a single attempt, no preset fallback)', async () => {
      results.set('alert_settings.upsert', { error: { code: '23514', message: 'alert_settings_alert_preset_check' } });
      const store = setup();
      await store.savePreferences(BASE);
      expect(callsOf('alert_settings', 'upsert')).toHaveLength(1);
      expect(store.saveMessage()).toEqual({ kind: 'error', text: MSG.saveFailed });
    });
  });

  describe('test notification', () => {
    async function enabledStore(): Promise<SettingsStore> {
      results.set('alert_settings.select', { data: { ...DEFAULT_ALERT_SETTINGS, enabled: true }, error: null });
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
      expect(invoke).not.toHaveBeenCalled();
    });

    it('reports the number of devices', async () => {
      invoke.mockResolvedValueOnce({ data: { sent: 2, removed: 0 }, error: null });
      const store = await enabledStore();
      const pending = store.sendTest();
      expect(store.testState()).toBe('pending');
      expect(store.canSendTest()).toBe(false);
      await pending;
      expect(invoke).toHaveBeenCalledWith('send-test-push', { method: 'POST' });
      expect(store.testState()).toBe('sent');
      expect(store.testSent()).toBe(2);
    });

    it('maps a 429 to « throttled »', async () => {
      invoke.mockResolvedValueOnce({ data: null, error: { name: 'FunctionsHttpError', context: new Response(null, { status: 429 }) } });
      const store = await enabledStore();
      await store.sendTest();
      expect(store.testState()).toBe('throttled');
    });

    it('maps other failures to « error »', async () => {
      invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(null, { status: 503 }) } });
      const store = await enabledStore();
      await store.sendTest();
      expect(store.testState()).toBe('error');
      invoke.mockRejectedValueOnce(new Error('network'));
      await store.sendTest();
      expect(store.testState()).toBe('error');
    });
  });
});
