import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { NotificationPreferences, NotificationSettings } from '@raijin/shared-contracts';
import { NotificationsApi, PushService, toClientError, type PushAvailability } from '@raijin/web-data-access';
import { RjButton, RjCard, RjIcon, RjSkeleton, RjSwitch, RjToastService } from '@raijin/web-ui';
import { TEXT_LINK } from '../shared/links';

type DeviceState = 'unknown' | 'subscribed' | 'not-subscribed';

/** Explication iOS : le push web n'existe que dans la PWA ajoutée à l'écran d'accueil. */
export const IOS_PUSH_HELP =
  'Sur iPhone et iPad, ajoute d’abord Raijin à l’écran d’accueil : touche Partager, puis « Sur l’écran d’accueil », et ouvre Raijin depuis son icône.';

/**
 * Carte « Notifications » de l'écran Compte : alertes par e-mail, résumé hebdomadaire, e-mails de
 * l'essai Pro (J+1 et J-2 ; l'e-mail de fin d'essai part toujours) et push.
 * Le push est réservé au plan Pro et à l'essai (message neutre en Gratuit, sans urgence). La
 * permission du navigateur n'est demandée qu'au clic sur « Activer sur cet appareil ».
 */
@Component({
  selector: 'rj-notification-settings',
  imports: [RouterLink, RjButton, RjCard, RjIcon, RjSkeleton, RjSwitch],
  template: `
    <rj-card>
      <div class="flex flex-col gap-1">
        <h2 id="rj-notifications-title" tabindex="-1" class="rounded-sm font-display text-h3 text-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring">Notifications</h2>
        <p class="text-body text-ink-muted">Comment Raijin te prévient quand il détecte un signal de risque sur un token suivi.</p>
      </div>

      @if (settings(); as settings) {
        <div class="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
          <div class="flex flex-col divide-y divide-line">
            <rj-switch
              label="Alertes par e-mail"
              [description]="settings.emailVerified ? 'Un e-mail groupé quand une alerte se déclenche sur un de tes suivis.' : 'Confirme ton adresse e-mail pour recevoir les alertes par e-mail.'"
              [checked]="settings.preferences.emailAlerts"
              [disabled]="!settings.emailVerified"
              [busy]="saving() === 'emailAlerts'"
              (checkedChange)="save('emailAlerts', $event)"
              data-pref="emailAlerts"
            />
            <rj-switch
              label="Résumé hebdomadaire"
              description="Chaque lundi matin, l’état de tes suivis et les alertes de la semaine."
              [checked]="settings.preferences.weeklyDigest"
              [disabled]="!settings.emailVerified"
              [busy]="saving() === 'weeklyDigest'"
              (checkedChange)="save('weeklyDigest', $event)"
              data-pref="weeklyDigest"
            />
            <rj-switch
              label="E-mails de l’essai"
              description="Le lendemain du début et deux jours avant la fin. L’e-mail de fin d’essai est toujours envoyé."
              [checked]="settings.preferences.trialEmails"
              [disabled]="!settings.emailVerified"
              [busy]="saving() === 'trialEmails'"
              (checkedChange)="save('trialEmails', $event)"
              data-pref="trialEmails"
            />
            @if (!settings.emailVerified) {
              <p class="py-3"><a routerLink="/compte/verifier-email" [class]="link">Confirmer mon adresse</a></p>
            }
          </div>

          <div class="flex flex-col divide-y divide-line border-t border-line lg:border-t-0">
            <rj-switch
              label="Notifications push"
              [description]="pushDescription()"
              [checked]="settings.pushAllowed && settings.pushConfigured && settings.preferences.pushAlerts"
              [disabled]="!settings.pushAllowed || !settings.pushConfigured"
              [busy]="saving() === 'pushAlerts'"
              (checkedChange)="save('pushAlerts', $event)"
              data-pref="pushAlerts"
            />
            @if (!settings.pushAllowed) {
              <p class="py-3" data-push-upgrade><a routerLink="/abonnement" [class]="link">Voir l’offre Pro</a></p>
            }
            @if (settings.pushAllowed && settings.pushConfigured) {
              <div class="flex flex-col gap-3 py-3" data-push-device>
                @switch (availability()) {
                  @case ('ios-install') {
                    <p class="flex items-start gap-2 rounded-md border border-line-strong bg-surface-raised p-3 text-body-sm text-ink" data-ios-help>
                      <rj-icon name="smartphone" [size]="16" class="mt-0.5 shrink-0 text-info" /><span>{{ iosHelp }}</span>
                    </p>
                  }
                  @case ('unsupported') {
                    <p class="flex items-start gap-2 text-body-sm text-ink-muted">
                      <rj-icon name="info" [size]="16" class="mt-0.5 shrink-0" /><span>Ce navigateur ne permet pas les notifications push. Tes alertes restent disponibles par e-mail et dans l’onglet Alertes.</span>
                    </p>
                  }
                  @default {
                    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <p class="flex items-center gap-2 text-body-sm text-ink">
                        @if (device() === 'subscribed') {
                          <rj-icon name="circleCheck" [size]="16" class="shrink-0 text-safe" />Activées sur cet appareil
                        } @else {
                          <rj-icon name="bellOff" [size]="16" class="shrink-0 text-ink-muted" />Pas encore activées sur cet appareil
                        }
                      </p>
                      @if (device() === 'subscribed') {
                        <button type="button" rjButton="ghost" icon="bellOff" class="sm:-my-1" [loading]="deviceBusy()" (click)="disableDevice()">Désactiver ici</button>
                      } @else {
                        <button type="button" rjButton="secondary" icon="bell" class="sm:-my-1" [loading]="deviceBusy()" [disabled]="denied()" (click)="enableDevice()">
                          Activer sur cet appareil
                        </button>
                      }
                    </div>
                    @if (pushError(); as pushError) {
                      <p class="flex flex-wrap items-center gap-x-2 text-body-sm text-ink" role="alert" data-push-error>
                        <span>{{ pushError }}</span>
                        <a routerLink="/compte/verifier-email" [class]="link">Renvoyer l’e-mail de confirmation</a>
                      </p>
                    }
                    @if (denied()) {
                      <p class="text-body-sm text-ink-muted" data-push-denied>
                        Les notifications sont bloquées pour Raijin dans les réglages de ton navigateur. Tu peux les autoriser depuis ces réglages.
                      </p>
                    }
                  }
                }
                <p class="text-label text-ink-muted">{{ devicesText() }}</p>
              </div>
            }
          </div>
        </div>
      } @else if (loadError()) {
        <div class="flex flex-col items-start gap-3" role="alert">
          <p class="flex items-start gap-2 text-body text-ink">
            <rj-icon name="circleAlert" [size]="20" class="mt-0.5 shrink-0 text-danger" /><span>{{ loadError() }}</span>
          </p>
          <button type="button" rjButton="secondary" icon="retry" [loading]="loading()" (click)="load()">Réessayer</button>
        </div>
      } @else {
        <div class="grid grid-cols-1 gap-x-8 lg:grid-cols-2" role="status" aria-busy="true" aria-label="Chargement des préférences">
          @for (row of [1, 2, 3]; track row) {
            <div class="flex items-center gap-4 py-3">
              <div class="flex flex-1 flex-col gap-2"><rj-skeleton class="h-4 w-40" /><rj-skeleton class="h-3 w-56 max-w-full" /></div>
              <rj-skeleton shape="circle" class="h-7 w-12" />
            </div>
          }
        </div>
      }
    </rj-card>
  `,
  host: { id: 'notifications', class: 'block scroll-mt-20' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjNotificationSettings {
  private readonly api = inject(NotificationsApi);
  private readonly push = inject(PushService);
  private readonly toasts = inject(RjToastService);

  protected readonly link = TEXT_LINK;
  protected readonly iosHelp = IOS_PUSH_HELP;
  protected readonly settings = signal<NotificationSettings | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal('');
  protected readonly saving = signal<keyof NotificationPreferences | null>(null);
  protected readonly device = signal<DeviceState>('unknown');
  protected readonly deviceBusy = signal(false);
  protected readonly availability = signal<PushAvailability>('unsupported');
  protected readonly denied = signal(false);
  protected readonly pushError = signal('');

  protected readonly pushDescription = computed(() => {
    const settings = this.settings();
    if (!settings) return '';
    if (!settings.pushAllowed) return 'Les notifications push font partie du plan Pro. Avec ton plan, tes alertes arrivent par e-mail et dans l’onglet Alertes.';
    if (!settings.pushConfigured) return 'Les notifications push ne sont pas encore disponibles. Tes alertes arrivent par e-mail et dans l’onglet Alertes.';
    return 'Une notification sur tes appareils dès qu’une alerte se déclenche.';
  });
  protected readonly devicesText = computed(() => {
    const count = this.settings()?.pushDevices ?? 0;
    if (count === 0) return 'Aucun appareil ne reçoit encore tes notifications.';
    return count > 1 ? `${count} appareils reçoivent tes notifications.` : '1 appareil reçoit tes notifications.';
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set('');
    try {
      this.settings.set(await this.api.settings());
      this.availability.set(this.push.availability());
      this.denied.set(this.push.permission() === 'denied');
      if (this.availability() === 'available') this.device.set((await this.push.refresh()) ? 'subscribed' : 'not-subscribed');
    } catch (error) {
      this.loadError.set(`Raijin n’a pas pu charger tes préférences. ${toClientError(error).message}`);
    } finally {
      this.loading.set(false);
    }
  }

  protected async save(key: keyof NotificationPreferences, value: boolean): Promise<void> {
    const previous = this.settings();
    if (!previous) return;
    this.settings.set({ ...previous, preferences: { ...previous.preferences, [key]: value } });
    this.saving.set(key);
    try {
      this.settings.set(await this.api.updatePreferences({ [key]: value }));
    } catch (error) {
      this.settings.set(previous);
      this.toasts.show(toClientError(error).message, { tone: 'error' });
    } finally {
      this.saving.set(null);
    }
  }

  /** Geste explicite : c'est ici, et seulement ici, que le navigateur demande la permission. */
  protected async enableDevice(): Promise<void> {
    this.deviceBusy.set(true);
    this.pushError.set('');
    const result = await this.push.enable();
    this.deviceBusy.set(false);
    if (result.ok) {
      this.device.set('subscribed');
      this.bumpDevices(1);
      this.toasts.show('Notifications activées sur cet appareil.', { tone: 'success' });
      return;
    }
    switch (result.reason) {
      case 'denied':
        this.denied.set(true);
        break;
      case 'ios-install':
      case 'unsupported':
        this.availability.set(result.reason);
        break;
      default:
        if (result.error.code === 'AUTH_EMAIL_NOT_VERIFIED') {
          this.pushError.set('Confirme d’abord ton adresse e-mail pour activer les notifications push.');
        } else {
          this.toasts.show(result.error.message, { tone: 'error' });
        }
    }
  }

  protected async disableDevice(): Promise<void> {
    this.deviceBusy.set(true);
    await this.push.disable();
    this.deviceBusy.set(false);
    this.device.set('not-subscribed');
    this.bumpDevices(-1);
    this.toasts.show('Notifications désactivées sur cet appareil.');
  }

  private bumpDevices(delta: number): void {
    const settings = this.settings();
    if (settings) this.settings.set({ ...settings, pushDevices: Math.max(0, settings.pushDevices + delta) });
  }
}
