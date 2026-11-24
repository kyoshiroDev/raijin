import { DOCUMENT, DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwPush } from '@angular/service-worker';
import { BENCH_ROUTES } from '@raijin/bench-contracts';
import { BenchApi, isBenchApiError } from '../../core/api/bench-api';
import { BROWSER_SNAPSHOT, pushCapability, type PushCapability } from '../../core/pwa/push-environment';
import { UserPreferences } from '../../core/preferences/user-preferences';
import {
  DEFAULT_ALERT_SETTINGS,
  parseAlertSettings,
  preferencesOf,
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
  tooMany: 'Trop d’appareils enregistrés (10 maximum). Désactive les notifications sur un ancien appareil.',
  denied: 'Notifications refusées. Pour les réactiver : Réglages iOS → Banc test → Notifications.',
  enableFailed: 'Impossible d’activer les notifications. Réessaie dans un instant.',
  disableFailed: 'Impossible de désactiver complètement les notifications. Réessaie dans un instant.',
  loadFailed: 'Impossible de charger tes réglages d’alerte.',
  saved: 'Réglages enregistrés.',
  saveFailed: 'Impossible d’enregistrer les réglages. Réessaie dans un instant.',
  /** Mode ombre : le banc du VPS n'envoie aucune notification (le banc de référence reste Supabase jusqu'à la bascule). */
  shadow: 'Banc en mode ombre : aucune notification n’est envoyée tant que la bascule n’est pas faite.',
} as const;

/** Clé publique VAPID du banc (`GET /api/push/vapid-public-key`), ou null si le push n'est pas configuré. */
function vapidKeyOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const key = (body as { publicKey?: unknown }).publicKey;
  return typeof key === 'string' && /^[A-Za-z0-9_-]{86,88}$/.test(key) ? key : null;
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
  private readonly api = inject(BenchApi);
  private readonly swPush = inject(SwPush);
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
      // The API answers the defaults when no row exists yet.
      this._settings.set(parseAlertSettings(await this.api.get(BENCH_ROUTES.alertSettings)));
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
      let serverPublicKey: string | null = null;
      try {
        serverPublicKey = vapidKeyOf(await this.api.get(BENCH_ROUTES.pushVapidKey));
      } catch {
        serverPublicKey = null;
      }
      if (serverPublicKey === null) {
        this._pushMessage.set({ kind: 'error', text: MSG.enableFailed });
        return;
      }
      let subscription: PushSubscription;
      try {
        subscription = await this.swPush.requestSubscription({ serverPublicKey });
      } catch {
        this.refreshEnvironment();
        this._pushMessage.set({ kind: 'error', text: this._snapshot().permission === 'denied' ? MSG.denied : MSG.enableFailed });
        return;
      }
      this.refreshEnvironment();
      this._subscription.set(subscription);

      const saved = await this.saveSubscription(subscription);
      if (saved !== 'ok') {
        this._pushMessage.set({ kind: 'error', text: saved === 'too-many' ? MSG.tooMany : MSG.enableFailed });
        return;
      }

      try {
        await this.api.put(BENCH_ROUTES.alertEnabled, { enabled: true });
      } catch {
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
        failed = !(await this.api.post(BENCH_ROUTES.pushUnsubscribe, { endpoint }).then(
          () => true,
          () => false,
        ));
      }
      try {
        await this.api.put(BENCH_ROUTES.alertEnabled, { enabled: false });
        this._settings.update((s) => ({ ...s, enabled: false }));
      } catch {
        failed = true;
      }
      if (failed) this._pushMessage.set({ kind: 'error', text: MSG.disableFailed });
    } catch {
      this._pushMessage.set({ kind: 'error', text: MSG.disableFailed });
    } finally {
      this._pushBusy.set(false);
    }
  }

  /**
   * « Enregistrer » : validates then saves the preferences, stake included (`PUT /api/settings/alerts`; the profile is
   * fixed server-side to 'young_calm', the only one left). Never `enabled`, never an archived column.
   */
  async savePreferences(prefs: AlertPreferences): Promise<AlertErrors> {
    const errors = validateAlertPreferences(prefs);
    if (Object.keys(errors).length > 0 || this._saving()) return errors;
    this._saving.set(true);
    this._saveMessage.set(null);
    const saved = preferencesOf(prefs);
    try {
      await this.api.put(BENCH_ROUTES.alertSettings, saved);
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
      this._testSent.set(sentCount(await this.api.post(BENCH_ROUTES.pushTest)));
      this._testState.set('sent');
    } catch (error) {
      this._testState.set(isBenchApiError(error, 429) ? 'throttled' : 'error');
    }
  }

  /** Re-registers the current subscription (keys may have rotated, or the row was cleaned up). Best effort. */
  private async syncSubscription(): Promise<void> {
    const sub = this._subscription();
    if (sub) await this.saveSubscription(sub).catch(() => undefined);
  }

  /** `POST /api/push/subscriptions` (single account: no ownership check needed). 409 = too many devices. */
  private async saveSubscription(sub: PushSubscription): Promise<'ok' | 'too-many' | 'error'> {
    const body = subscriptionRow(sub.toJSON());
    if (!body) return 'error';
    try {
      await this.api.post(BENCH_ROUTES.pushSubscriptions, body);
      return 'ok';
    } catch (error) {
      return isBenchApiError(error, 409) ? 'too-many' : 'error';
    }
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
