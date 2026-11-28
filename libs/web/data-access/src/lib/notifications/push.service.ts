import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom, race, timer, map } from 'rxjs';
import { toClientError, type ClientError } from '../http/api-error';
import { NotificationsApi } from './notifications-api';

/**
 * - `available` : le navigateur peut s'abonner (service worker actif, Push API, Notification) ;
 * - `ios-install` : iPhone / iPad hors PWA installée : il faut d'abord ajouter Raijin à l'écran d'accueil ;
 * - `unsupported` : navigateur sans push, ou service worker inactif (développement).
 */
export type PushAvailability = 'available' | 'ios-install' | 'unsupported';

export type PushEnableResult =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'unsupported' | 'ios-install' }
  | { ok: false; reason: 'error'; error: ClientError };

/** Délai maximal d'attente du service worker pour lire l'abonnement courant. */
const SUBSCRIPTION_TIMEOUT_MS = 3000;

type PushWindow = Window & { PushManager?: unknown; Notification?: { permission: NotificationPermission } };

/** iPhone, iPad (y compris iPadOS qui se présente comme un Mac tactile). */
export function isIosDevice(view: Window | null): boolean {
  const nav = view?.navigator;
  if (!nav) return false;
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

/** PWA lancée depuis l'écran d'accueil. */
export function isStandalone(view: Window | null): boolean {
  if (!view) return false;
  const nav = view.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || view.matchMedia?.('(display-mode: standalone)').matches === true;
}

/**
 * Push web sur le service worker Angular (`SwPush`, docs/ARCHITECTURE.md §11.7) : aucun service
 * worker maison. La permission n'est **jamais** demandée au chargement : seulement par `enable()`,
 * appelé depuis un geste explicite (bouton « Activer les notifications »). Un refus n'est jamais
 * relancé automatiquement. Fourni par `providePushNotifications` (route de l'écran Compte).
 */
@Injectable()
export class PushService {
  private readonly swPush = inject(SwPush, { optional: true });
  private readonly api = inject(NotificationsApi);
  private readonly view = inject(DOCUMENT).defaultView as PushWindow | null;
  private readonly subscribedState = signal(false);

  /** Cet appareil est abonné (dernier état connu). */
  readonly subscribed = this.subscribedState.asReadonly();

  availability(): PushAvailability {
    if (isIosDevice(this.view) && !isStandalone(this.view)) return 'ios-install';
    if (!this.swPush?.isEnabled || !this.view?.PushManager || !this.view.Notification) return 'unsupported';
    return 'available';
  }

  /** Permission du navigateur (`unsupported` sans API Notification). */
  permission(): NotificationPermission | 'unsupported' {
    return this.view?.Notification?.permission ?? 'unsupported';
  }

  /** Relit l'abonnement de cet appareil (sans rien demander à l'utilisateur). */
  async refresh(): Promise<boolean> {
    const subscription = await this.currentSubscription();
    this.subscribedState.set(subscription !== null);
    return subscription !== null;
  }

  /** À appeler uniquement depuis un geste explicite : affiche la demande de permission du navigateur. */
  async enable(): Promise<PushEnableResult> {
    const availability = this.availability();
    if (availability !== 'available' || !this.swPush) return { ok: false, reason: availability === 'ios-install' ? 'ios-install' : 'unsupported' };
    let subscription: PushSubscription;
    try {
      const serverPublicKey = await this.api.vapidPublicKey();
      subscription = await this.swPush.requestSubscription({ serverPublicKey });
    } catch (error) {
      if (this.permission() === 'denied') return { ok: false, reason: 'denied' };
      return { ok: false, reason: 'error', error: toClientError(error) };
    }
    try {
      await this.api.subscribe(subscription.toJSON());
      this.subscribedState.set(true);
      return { ok: true };
    } catch (error) {
      // Refusé par l'API (plan, abonnement invalide) : on ne garde pas d'abonnement orphelin.
      await subscription.unsubscribe().catch(() => undefined);
      this.subscribedState.set(false);
      return { ok: false, reason: 'error', error: toClientError(error) };
    }
  }

  /** Désabonne cet appareil (API puis navigateur). Silencieux : appelé aussi à la déconnexion. */
  async disable(): Promise<void> {
    const subscription = await this.currentSubscription();
    if (subscription) {
      await this.api.unsubscribe(subscription.endpoint).catch(() => undefined);
      await this.swPush?.unsubscribe().catch(() => subscription.unsubscribe().catch(() => undefined));
    }
    this.subscribedState.set(false);
  }

  private async currentSubscription(): Promise<PushSubscription | null> {
    if (!this.swPush?.isEnabled) return null;
    return firstValueFrom(race(this.swPush.subscription, timer(SUBSCRIPTION_TIMEOUT_MS).pipe(map(() => null))));
  }
}
