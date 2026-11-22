import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ADMIN_EXPIRED_REASON, AdminSecurityApi, AdminSessionStore, safeAdminReturn, toClientError } from '@raijin/web-data-access';
import { RjButton, RjInputField, RjMascot, RjToastService } from '@raijin/web-ui';
import { RjAdminAlert } from '../ui/alert';
import { RjOtpInput } from './otp-input';

/**
 * Saisie du code admin : code de l'application (6 chiffres) ou, en bascule, un code de secours (usage unique).
 * Après une expiration (`?motif=expiree`), Rai alerte et un message expliquent pourquoi le code est redemandé.
 * Retour à la page demandée (`?retour=`, limité aux écrans de la coque admin).
 */
@Component({
  selector: 'rj-admin-verify-page',
  imports: [RjButton, RjInputField, RjMascot, RjAdminAlert, RjOtpInput],
  template: `
    <header class="flex flex-col gap-2">
      @if (expired()) {
        <rj-mascot pose="alerte" size="sm" class="mb-2 self-start" />
      }
      <p class="text-label font-semibold tracking-wide text-thunder-ink uppercase">Espace admin</p>
      <h1 class="font-display text-h2 text-ink">{{ expired() ? 'Session admin expirée' : 'Confirme que c’est bien toi' }}</h1>
      <p class="text-body text-ink-muted">
        @if (expired()) {
          Après une période sans activité, Raijin masque les données admin. Ta session de l’app reste ouverte&nbsp;: saisis
          un nouveau code pour reprendre où tu en étais.
        } @else if (method() === 'recovery') {
          Saisis un de tes codes de secours. Il ne pourra plus resservir.
        } @else {
          Saisis le code affiché dans ton application d’authentification.
        }
      </p>
    </header>

    @if (alert(); as alert) {
      <rj-admin-alert [tone]="alert.tone">{{ alert.message }}</rj-admin-alert>
    }

    <form class="flex flex-col gap-4" (submit)="$event.preventDefault(); submit()" novalidate>
      @if (method() === 'totp') {
        <rj-otp-input [(value)]="code" [error]="codeError()" [disabled]="busy()" (complete)="submit()" />
      } @else {
        <rj-input-field
          label="Code de secours"
          name="recovery-code"
          [(value)]="recovery"
          [mono]="true"
          [maxlength]="13"
          autocomplete="off"
          enterkeyhint="done"
          placeholder="ABCDE-FGH23"
          hint="Chaque code de secours ne fonctionne qu’une fois."
          [error]="codeError()"
          [disabled]="busy()"
        />
      }
      <button type="submit" rjButton="primary" size="lg" [block]="true" icon="safe" [loading]="busy()" [disabled]="!ready()">
        Ouvrir l’espace admin
      </button>
    </form>

    <button
      type="button"
      class="-mx-2 inline-flex min-h-11 items-center self-center rounded-md px-2 text-body-sm font-medium text-info transition-colors duration-150 ease-raijin hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      (click)="toggleMethod()"
    >
      {{ method() === 'totp' ? 'Je n’ai pas mon téléphone : utiliser un code de secours' : 'Utiliser le code de l’application' }}
    </button>
  `,
  host: { class: 'flex flex-col gap-6' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminVerifyPage {
  private readonly api = inject(AdminSecurityApi);
  private readonly session = inject(AdminSessionStore);
  private readonly router = inject(Router);
  private readonly toasts = inject(RjToastService);

  /** Paramètres de requête (liaison des entrées de route). */
  readonly retour = input<string | null>(null);
  readonly motif = input<string | null>(null);

  protected readonly method = signal<'totp' | 'recovery'>('totp');
  protected readonly code = signal('');
  protected readonly recovery = signal('');
  protected readonly busy = signal(false);
  protected readonly codeError = signal('');
  protected readonly alert = signal<{ tone: 'danger' | 'warn'; message: string } | null>(null);

  protected readonly expired = computed(() => this.motif() === ADMIN_EXPIRED_REASON || this.session.lockReason() === 'expired');
  protected readonly ready = computed(() =>
    this.method() === 'totp' ? this.code().length === 6 : /^[A-Za-z2-7]{5}-?[A-Za-z2-7]{5}$/.test(this.recovery().replace(/\s+/g, '')),
  );

  protected toggleMethod(): void {
    this.method.update((method) => (method === 'totp' ? 'recovery' : 'totp'));
    this.codeError.set('');
    this.alert.set(null);
  }

  protected async submit(): Promise<void> {
    if (this.busy() || !this.ready()) return;
    this.busy.set(true);
    this.codeError.set('');
    this.alert.set(null);
    try {
      const status =
        this.method() === 'totp'
          ? await this.api.verify({ method: 'totp', code: this.code() })
          : await this.api.verify({ method: 'recovery', code: normalizeRecovery(this.recovery()) });
      this.session.applyStatus(status);
      if (this.session.recoveryCodesLow()) {
        this.toasts.show(`Il te reste ${status.recoveryCodesRemaining ?? 0} code(s) de secours. Régénère-les depuis « Double authentification ».`, {
          tone: 'info',
          duration: 8000,
        });
      }
      await this.router.navigateByUrl(safeAdminReturn(this.retour()));
    } catch (error) {
      const client = toClientError(error);
      this.code.set('');
      if (client.code === 'ADMIN_2FA_INVALID') this.codeError.set(client.message);
      else this.alert.set({ tone: client.code === 'ADMIN_2FA_LOCKED' ? 'warn' : 'danger', message: client.message });
    } finally {
      this.busy.set(false);
    }
  }
}

/** « abcde fgh23 » ou « ABCDEFGH23 » → « ABCDE-FGH23 ». */
export function normalizeRecovery(value: string): string {
  const compact = value.replace(/[\s-]+/g, '').toUpperCase();
  return compact.length === 10 ? `${compact.slice(0, 5)}-${compact.slice(5)}` : compact;
}
