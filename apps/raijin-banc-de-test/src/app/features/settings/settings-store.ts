import { DOCUMENT, DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwPush } from '@angular/service-worker';
import { BROWSER_SNAPSHOT, pushCapability, type PushCapability } from '../../core/pwa/push-environment';
import { VAPID_PUBLIC_KEY } from '../../core/pwa/push-config';
import { UserPreferences } from '../../core/preferences/user-preferences';
import { SUPABASE } from '../../core/supabase/supabase-client';
import {
  ALERT_SETTINGS_COLUMNS,
  DEFAULT_ALERT_SETTINGS,
  parseAlertSettings,
  preferencesOf,
  preferencesPayload,
  subscriptionRow,
  validateAlertPreferences,
  type AlertErrors,
  type AlertPreferences,
  type AlertSettings,
} from './alert-settings';

/** What the notification switch shows. */
export type PushStatus = Exclude<PushCapability, 'available'> | 'off' | 'on';
export type TestPushState = 'idle' | 'pending' | 'sent' | 'throttled' | 'error';
export interface Feedback {
  kind: 'ok' | 'error';
  text: string;
}

export const MSG = {
  otherAccount:
    'Cet appareil est déjà lié à un autre compte. Il vient d’en être délié : touche à nouveau l’interrupteur pour l’activer sur ce compte.',
  tooMany: 'Trop d’appareils enregistrés (10 maximum). Désactive les notifications sur un ancien appareil.',
  denied: 'Notifications refusées. Pour les réactiver : Réglages iOS → Banc test → Notifications.',
  enableFailed: 'Impossible d’activer les notifications. Réessaie dans un instant.',
  disableFailed: 'Impossible de désactiver complètement les notifications. Réessaie dans un instant.',
  loadFailed: 'Impossible de charger tes réglages d’alerte.',
  saved: 'Réglages enregistrés.',
  saveFailed: 'Impossible d’enregistrer les réglages. Réessaie dans un instant.',
} as const;

interface DbError {
  code?: string;
  message?: string;
}

function asDbError(error: unknown): DbError {
  return typeof error === 'object' && error !== null ? (error as DbError) : {};
}

/** HTTP status of a failed `functions.invoke` (FunctionsHttpError keeps the Response in `context`). */
function httpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('context' in error)) return null;
  const context: unknown = (error as { context: unknown }).context;
  if (typeof context === 'object' && context !== null && 'status' in context) {
    const status: unknown = (context as { status: unknown }).status;
    return typeof status === 'number' ? status : null;
  }
  return null;
}

function sentCount(data: unknown): number {
  if (typeof data !== 'object' || data === null) return 0;
  const sent: unknown = (data as { sent?: unknown }).sent;
  return typeof sent === 'number' && Number.isInteger(sent) && sent >= 0 ? sent : 0;
}

/**
 * Notifications + alert preferences of the signed-in user (provided by SettingsPage).
 * Permission is ONLY requested from `enable()`, i.e. on a tap (iOS requirement): nothing here
 * calls `requestSubscription` on load.
 */
@Injectable()
export class SettingsStore {
  private readonly supabase = inject(SUPABASE);
  private readonly swPush = inject(SwPush);
  private readonly vapidPublicKey = inject(VAPID_PUBLIC_KEY);
  private readonly readSnapshot = inject(BROWSER_SNAPSHOT);
  private readonly document = inject(DOCUMENT);
  private readonly preferences = inject(UserPreferences);

  private readonly _snapshot = signal(this.readSnapshot());
  private readonly _subscription = signal<PushSubscription | null>(null);
  private readonly _settings = signal<AlertSettings>({ ...DEFAULT_ALERT_SETTINGS });
  private readonly _loaded = signal(false);
  private readonly _loadError = signal<string | null>(null);
  private readonly _pushBusy = signal(false);
  private readonly _pushMessage = signal<Feedback | null>(null);
  private readonly _saving = signal(false);
  private readonly _saveMessage = signal<Feedback | null>(null);
  private readonly _testState = signal<TestPushState>('idle');
  private readonly _testSent = signal(0);

  readonly settings = this._settings.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly loadError = this._loadError.asReadonly();
  readonly pushBusy = this._pushBusy.asReadonly();
  readonly pushMessage = this._pushMessage.asReadonly();
  readonly saving = this._saving.asReadonly();
  readonly saveMessage = this._saveMessage.asReadonly();
  readonly testState = this._testState.asReadonly();
  readonly testSent = this._testSent.asReadonly();

  readonly capability = computed<PushCapability>(() => {
    const cap = pushCapability(this._snapshot());
    // SW disabled (dev server) or not registered: SwPush cannot subscribe.
    return cap === 'available' && !this.swPush.isEnabled ? 'unsupported' : cap;
  });

  readonly status = computed<PushStatus>(() => {
    const cap = this.capability();
    if (cap !== 'available') return cap;
    return this._subscription() !== null && this._settings().enabled ? 'on' : 'off';
  });

  readonly canSendTest = computed(() => this.status() === 'on' && this._testState() !== 'pending');

  constructor() {
    const destroyRef = inject(DestroyRef);
    if (this.swPush.isEnabled) {
      this.swPush.subscription.pipe(takeUntilDestroyed(destroyRef)).subscribe((sub) => this._subscription.set(sub));
    }
    // Back from iOS Settings (permission toggled there): re-read the browser state.
    const onVisible = () => {
      if (this.document.visibilityState === 'visible') this.refreshEnvironment();
    };
    this.document.addEventListener('visibilitychange', onVisible);
    destroyRef.onDestroy(() => this.document.removeEventListener('visibilitychange', onVisible));
  }

  refreshEnvironment(): void {
    this._snapshot.set(this.readSnapshot());
  }

  async load(): Promise<void> {
    this._loadError.set(null);
    try {
      const { data, error } = await this.supabase.from('alert_settings').select(ALERT_SETTINGS_COLUMNS).maybeSingle();
      if (error) throw error;
      this._settings.set(data ? parseAlertSettings(data) : { ...DEFAULT_ALERT_SETTINGS });
      this.preferences.setStake(this._settings().stake_sol);
      this.preferences.setPaperSlPct(this._settings().paper_sl_pct);
    } catch {
      this._loadError.set(MSG.loadFailed);
    } finally {
      this._loaded.set(true);
    }
    if (this.status() === 'on') void this.syncSubscription();
  }

  /** Switch tapped. */
  async toggle(): Promise<void> {
    if (this.status() === 'on') await this.disable();
    else await this.enable();
  }

  /** Asks the permission (user gesture only), stores the subscription and enables alerts. */
  async enable(): Promise<void> {
    if (this._pushBusy()) return;
    const cap = this.capability();
    if (cap === 'ios-install' || cap === 'unsupported') return;
    this._pushBusy.set(true);
    this._pushMessage.set(null);
    try {
      let subscription: PushSubscription;
      try {
        subscription = await this.swPush.requestSubscription({ serverPublicKey: this.vapidPublicKey });
      } catch {
        this.refreshEnvironment();
        this._pushMessage.set({ kind: 'error', text: this._snapshot().permission === 'denied' ? MSG.denied : MSG.enableFailed });
        return;
      }
      this.refreshEnvironment();
      this._subscription.set(subscription);

      const saved = await this.saveSubscription(subscription);
      if (saved !== 'ok') {
        if (saved === 'other-account') await this.unsubscribeBrowser();
        this._pushMessage.set({
          kind: 'error',
          text: saved === 'other-account' ? MSG.otherAccount : saved === 'too-many' ? MSG.tooMany : MSG.enableFailed,
        });
        return;
      }

      const { error } = await this.supabase.from('alert_settings').upsert({ enabled: true }, { onConflict: 'user_id' });
      if (error) {
        this._pushMessage.set({ kind: 'error', text: MSG.enableFailed });
        return;
      }
      this._settings.update((s) => ({ ...s, enabled: true }));
    } catch {
      this._pushMessage.set({ kind: 'error', text: MSG.enableFailed });
    } finally {
      this._pushBusy.set(false);
    }
  }

  /** Unsubscribes this device, deletes its row and disables alerts for the account. */
  async disable(): Promise<void> {
    if (this._pushBusy()) return;
    this._pushBusy.set(true);
    this._pushMessage.set(null);
    const endpoint = this._subscription()?.endpoint ?? null;
    try {
      await this.unsubscribeBrowser();
      let failed = false;
      if (endpoint) {
        const { error } = await this.supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
        failed ||= !!error;
      }
      const { error } = await this.supabase.from('alert_settings').upsert({ enabled: false }, { onConflict: 'user_id' });
      if (error) failed = true;
      else this._settings.update((s) => ({ ...s, enabled: false }));
      if (failed) this._pushMessage.set({ kind: 'error', text: MSG.disableFailed });
    } catch {
      this._pushMessage.set({ kind: 'error', text: MSG.disableFailed });
    } finally {
      this._pushBusy.set(false);
    }
  }

  /**
   * « Enregistrer » : validates then upserts the preferences, stake included, with alert_preset = 'young_calm' (the
   * only profile left). Never `enabled`, never an archived column.
   */
  async savePreferences(prefs: AlertPreferences): Promise<AlertErrors> {
    const errors = validateAlertPreferences(prefs);
    if (Object.keys(errors).length > 0 || this._saving()) return errors;
    this._saving.set(true);
    this._saveMessage.set(null);
    const payload = preferencesPayload(prefs);
    try {
      const { error } = await this.supabase.from('alert_settings').upsert(payload, { onConflict: 'user_id' });
      if (error) throw error;
      const saved = preferencesOf(payload);
      this._settings.update((s) => ({ ...s, ...saved }));
      this.preferences.setStake(saved.stake_sol);
      this.preferences.setPaperSlPct(saved.paper_sl_pct);
      this._saveMessage.set({ kind: 'ok', text: MSG.saved });
    } catch {
      this._saveMessage.set({ kind: 'error', text: MSG.saveFailed });
    } finally {
      this._saving.set(false);
    }
    return {};
  }

  async sendTest(): Promise<void> {
    if (!this.canSendTest()) return;
    this._testState.set('pending');
    try {
      const { data, error } = await this.supabase.functions.invoke('send-test-push', { method: 'POST' });
      if (error) {
        this._testState.set(httpStatus(error) === 429 ? 'throttled' : 'error');
        return;
      }
      this._testSent.set(sentCount(data));
      this._testState.set('sent');
    } catch {
      this._testState.set('error');
    }
  }

  /** Re-registers the current subscription (keys may have rotated, or the row was cleaned up). Best effort. */
  private async syncSubscription(): Promise<void> {
    const sub = this._subscription();
    if (sub) await this.saveSubscription(sub).catch(() => undefined);
  }

  private async saveSubscription(sub: PushSubscription): Promise<'ok' | 'other-account' | 'too-many' | 'error'> {
    const row = subscriptionRow(sub.toJSON(), this.document.defaultView?.navigator.userAgent ?? '');
    if (!row) return 'error';
    // user_id is filled by its default (auth.uid()); RLS rejects an endpoint owned by another account.
    const { error } = await this.supabase.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' });
    if (!error) return 'ok';
    const { code, message } = asDbError(error);
    if (code === '42501') return 'other-account';
    if (code === '23514' && /too many push subscriptions/i.test(message ?? '')) return 'too-many';
    return 'error';
  }

  private async unsubscribeBrowser(): Promise<void> {
    try {
      await this.swPush.unsubscribe();
    } catch {
      // Already unsubscribed (or no SW): nothing else to do on the browser side.
    }
    this._subscription.set(null);
  }
}
