import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { NotificationPreferencesUpdate, NotificationSettings, PushSubscriptionRequest } from '@raijin/shared-contracts';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from '../config/api-config';
import { loadContracts } from '../contracts';

/**
 * Client HTTP des préférences de notification et du push (`/api/v1/notifications`, `/api/v1/push`).
 * La clé publique VAPID est servie par l'API (jamais compilée dans le front) ; la clé privée ne
 * quitte jamais le serveur.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  async settings(): Promise<NotificationSettings> {
    const [body, contracts] = await Promise.all([firstValueFrom(this.http.get(`${this.base}/notifications/settings`)), loadContracts()]);
    return contracts.notificationSettingsSchema.parse(body);
  }

  async updatePreferences(patch: NotificationPreferencesUpdate): Promise<NotificationSettings> {
    const [body, contracts] = await Promise.all([
      firstValueFrom(this.http.patch(`${this.base}/notifications/preferences`, patch)),
      loadContracts(),
    ]);
    return contracts.notificationSettingsSchema.parse(body);
  }

  /** 503 `PUSH_NOT_SUPPORTED` si le serveur n'a pas de clés VAPID. */
  async vapidPublicKey(): Promise<string> {
    const [body, contracts] = await Promise.all([firstValueFrom(this.http.get(`${this.base}/push/vapid-public-key`)), loadContracts()]);
    return contracts.vapidPublicKeyResponseSchema.parse(body).publicKey;
  }

  /** Abonnement validé côté front aussi (service push connu, clés au bon format) avant l'envoi. */
  async subscribe(subscription: unknown): Promise<void> {
    const contracts = await loadContracts();
    const body: PushSubscriptionRequest = contracts.pushSubscriptionRequestSchema.parse(subscription);
    await firstValueFrom(this.http.post(`${this.base}/push/subscriptions`, body));
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await firstValueFrom(this.http.post(`${this.base}/push/unsubscribe`, { endpoint }));
  }
}
