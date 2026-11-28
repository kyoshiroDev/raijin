import { ChangeDetectionStrategy, Component, ElementRef, Injector, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { type AdminEnrollmentStart } from '@raijin/shared-contracts';
import { ADMIN_PATHS, AdminSecurityApi, AdminSessionStore, toClientError } from '@raijin/web-data-access';
import { RjButton, RjClipboard, RjErrorState, RjIcon, RjInputField, RjSkeleton, RjToastService } from '@raijin/web-ui';
import { RjAdminAlert } from '../ui/alert';
import { formatTime } from '../ui/format';
import { focusStepTitle } from './focus';
import { RjOtpInput } from './otp-input';

/** Secret base32 en groupes de 4 caractères, plus facile à recopier. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Activation de la double authentification (admin pas encore enrôlé) : QR code à scanner, clé à saisir à la main
 * (copiable), lien direct vers l'application sur mobile, puis code à 6 chiffres et mot de passe actuel (une
 * session volée ne suffit pas à lier une 2FA). Après confirmation, les codes de
 * secours sont montrés une seule fois (écran suivant).
 */
@Component({
  selector: 'rj-admin-enrollment-page',
  imports: [RjButton, RjErrorState, RjIcon, RjInputField, RjSkeleton, RjAdminAlert, RjOtpInput],
  template: `
    <header class="flex flex-col gap-2">
      <p class="text-label font-semibold tracking-wide text-thunder-ink uppercase">Espace admin · étape 1 sur 2</p>
      <h1 class="font-display text-h2 text-ink">Active la double authentification</h1>
      <p class="text-body text-ink-muted">
        L’espace admin demande un code de ton application d’authentification (Google Authenticator, 1Password, Aegis…)
        à chaque nouvelle session.
      </p>
    </header>

    @switch (state()) {
      @case ('loading') {
        <div class="flex flex-col gap-4" role="status" aria-busy="true" aria-label="Préparation du QR code…">
          <rj-skeleton shape="block" class="mx-auto size-48" />
          <rj-skeleton class="h-12 w-full" />
          <rj-skeleton class="h-14 w-full" />
        </div>
      }
      @case ('error') {
        <rj-error-state
          title="Raijin n’a pas pu préparer l’activation"
          description="L’API ne répond pas. Vérifie ta connexion puis réessaie."
          [retrying]="starting()"
          (retry)="start()"
        />
      }
      @default {
        @if (enrollment(); as enrollment) {
          <ol class="flex flex-col gap-6">
            <li class="flex flex-col gap-3">
              <h2 class="flex items-center gap-2 font-display text-h3 text-ink">
                <span class="tabular inline-flex size-7 items-center justify-center rounded-full bg-surface-raised text-label text-ink" aria-hidden="true">1</span>
                Ajoute Raijin à ton application
              </h2>
              <div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                <div class="shrink-0 rounded-md border border-line bg-surface-raised p-3">
                  <img
                    [src]="enrollment.qrCodeDataUri"
                    width="176"
                    height="176"
                    class="block size-44 rounded-sm"
                    alt="QR code à scanner avec ton application d’authentification"
                  />
                </div>
                <div class="flex w-full min-w-0 flex-col gap-2">
                  <p class="text-body-sm text-ink-muted">Scanne le QR code, ou saisis cette clé à la main (type « basé sur le temps ») :</p>
                  <p class="sr-only">Clé secrète : {{ enrollment.secret }}</p>
                  <p class="grid grid-cols-4 gap-x-2 gap-y-1 rounded-md border border-line bg-surface-raised px-3 py-2.5 text-center font-mono text-body font-semibold tracking-wider text-ink select-all" aria-hidden="true">
                    @for (group of groups(); track $index) {
                      <span>{{ group }}</span>
                    }
                  </p>
                  <div class="grid grid-cols-1 gap-2">
                    <button type="button" rjButton="secondary" [icon]="copied() ? 'check' : 'copy'" (click)="copySecret(enrollment.secret)">
                      {{ copied() ? 'Clé copiée' : 'Copier la clé' }}
                    </button>
                    <a rjButton="ghost" icon="smartphone" [href]="enrollment.otpauthUri" class="sm:hidden">Ouvrir l’application</a>
                  </div>
                </div>
              </div>
              <p class="flex items-center gap-1.5 text-body-sm text-ink-muted">
                <rj-icon name="clock" [size]="16" />Valable jusqu’à {{ expiresAt() }}. Ne partage jamais cette clé.
              </p>
            </li>

            <li class="flex flex-col gap-3">
              <h2 class="flex items-center gap-2 font-display text-h3 text-ink">
                <span class="tabular inline-flex size-7 items-center justify-center rounded-full bg-surface-raised text-label text-ink" aria-hidden="true">2</span>
                Saisis le code affiché
              </h2>
              @if (alert(); as alert) {
                <rj-admin-alert [tone]="alert.tone">
                  <div class="flex flex-col gap-2">
                    <span>{{ alert.message }}</span>
                    @if (alert.restart) {
                      <button type="button" rjButton="secondary" icon="retry" class="self-start" [loading]="starting()" (click)="start()">Recommencer</button>
                    }
                  </div>
                </rj-admin-alert>
              }
              <form class="flex flex-col gap-4" (submit)="$event.preventDefault(); confirm()" novalidate>
                <rj-otp-input [(value)]="code" [error]="codeError()" [disabled]="confirming()" hint="Le code change toutes les 30 secondes." />
                <rj-input-field
                  label="Mot de passe actuel"
                  name="current-password"
                  type="password"
                  autocomplete="current-password"
                  enterkeyhint="done"
                  [revealable]="true"
                  [required]="true"
                  [(value)]="password"
                  [error]="passwordError()"
                  [disabled]="confirming()"
                  hint="Confirme qu’il s’agit bien de toi avant de lier ton application."
                />
                <!-- Annonce immédiate du refus (le message visible est aussi lié au champ par aria-describedby). -->
                <p class="sr-only" role="alert">{{ passwordError() }}</p>
                <button type="submit" rjButton="primary" size="lg" [block]="true" icon="safe" [loading]="confirming()" [disabled]="!canConfirm()">
                  Confirmer le code
                </button>
              </form>
            </li>
          </ol>
        }
      }
    }
  `,
  host: { class: 'flex flex-col gap-6' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminEnrollmentPage {
  private readonly api = inject(AdminSecurityApi);
  private readonly session = inject(AdminSessionStore);
  private readonly router = inject(Router);
  private readonly clipboard = inject(RjClipboard);
  private readonly toasts = inject(RjToastService);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  protected readonly enrollment = signal<AdminEnrollmentStart | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly starting = signal(false);
  protected readonly confirming = signal(false);
  protected readonly copied = signal(false);
  protected readonly code = signal('');
  protected readonly codeError = signal('');
  protected readonly password = signal('');
  protected readonly passwordError = signal('');
  protected readonly canConfirm = computed(() => this.code().length === 6 && this.password().length > 0);
  protected readonly alert = signal<{ tone: 'danger' | 'warn'; message: string; restart: boolean } | null>(null);

  protected readonly groups = computed(() => groupSecret(this.enrollment()?.secret ?? '').split(' ').filter(Boolean));
  protected readonly expiresAt = computed(() => {
    const enrollment = this.enrollment();
    return enrollment ? formatTime(enrollment.expiresAt) : '';
  });

  constructor() {
    void this.start();
  }

  protected async start(): Promise<void> {
    this.starting.set(true);
    this.alert.set(null);
    this.codeError.set('');
    this.passwordError.set('');
    this.code.set('');
    try {
      const restarting = this.enrollment() !== null;
      this.enrollment.set(await this.api.startEnrollment());
      this.state.set('ready');
      // « Recommencer » après une expiration : nouveau QR code, retour en haut de l'étape 1.
      if (restarting) focusStepTitle(this.host, this.injector);
    } catch (error) {
      const client = toClientError(error);
      if (client.code === 'ADMIN_2FA_ALREADY_ENROLLED') {
        await this.router.navigateByUrl(ADMIN_PATHS.verify);
        return;
      }
      if (this.enrollment()) this.alert.set({ tone: 'danger', message: client.message, restart: true });
      else this.state.set('error');
    } finally {
      this.starting.set(false);
    }
  }

  protected async copySecret(secret: string): Promise<void> {
    const ok = await this.clipboard.copy(secret);
    this.copied.set(ok);
    if (!ok) this.toasts.show('Copie impossible : recopie la clé à la main.', { tone: 'error' });
  }

  protected async confirm(): Promise<void> {
    if (this.confirming() || !this.canConfirm()) return;
    this.confirming.set(true);
    this.codeError.set('');
    this.passwordError.set('');
    this.alert.set(null);
    try {
      const result = await this.api.confirmEnrollment(this.code(), this.password());
      this.session.setPendingRecoveryCodes(result.recoveryCodes);
      this.session.applyStatus(result.status);
      await this.router.navigateByUrl(ADMIN_PATHS.recoveryCodes);
    } catch (error) {
      const client = toClientError(error);
      if (client.code === 'AUTH_INVALID_CREDENTIALS') {
        // Code de l'application gardé : seul le mot de passe est à ressaisir.
        this.password.set('');
        this.passwordError.set('Mot de passe incorrect. Saisis le mot de passe de ton compte Raijin.');
        return;
      }
      this.code.set('');
      if (client.code === 'ADMIN_2FA_INVALID') this.codeError.set(client.message);
      else if (client.code === 'ADMIN_2FA_ENROLLMENT_EXPIRED') this.alert.set({ tone: 'warn', message: client.message, restart: true });
      else this.alert.set({ tone: 'danger', message: client.message, restart: false });
    } finally {
      this.confirming.set(false);
    }
  }
}
