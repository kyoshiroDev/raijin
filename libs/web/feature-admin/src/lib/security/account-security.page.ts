import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { type AdminRecoveryCodes } from '@raijin/shared-contracts';
import { AdminSecurityApi, AdminSessionStore, toClientError } from '@raijin/web-data-access';
import { RjButton, RjIcon } from '@raijin/web-ui';
import { RjAdminAlert } from '../ui/alert';
import { formatTime } from '../ui/format';
import { RjAdminPageHeader, RjAdminPanel } from '../ui/layout';
import { RjOtpInput } from './otp-input';
import { RjRecoveryCodesList } from './recovery-codes-list';

/**
 * État de la double authentification de l'admin (dans la coque) : session en cours, codes de secours restants,
 * régénération des codes (code TOTP frais ; les anciens codes sont invalidés, les nouveaux montrés une fois).
 * La réinitialisation complète de la 2FA passe par la CLI (`api:admin-reset-2fa`), jamais par l'interface.
 */
@Component({
  selector: 'rj-admin-account-security-page',
  imports: [RjButton, RjIcon, RjAdminAlert, RjAdminPageHeader, RjAdminPanel, RjOtpInput, RjRecoveryCodesList],
  template: `
    <div class="flex flex-col gap-6">
      <rj-admin-page-header title="Double authentification" description="Ta protection d’accès à l’espace admin." />

      <div class="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
        <rj-admin-panel title="Session admin">
          <dl class="flex flex-col divide-y divide-line">
            <div class="flex items-center justify-between gap-4 py-3 first:pt-0">
              <dt class="text-body-sm text-ink-muted">Double authentification</dt>
              <dd class="inline-flex items-center gap-1.5 text-body text-ink"><rj-icon name="circleCheck" [size]="16" class="text-safe" />Active</dd>
            </div>
            <div class="flex items-center justify-between gap-4 py-3">
              <dt class="text-body-sm text-ink-muted">Fin si inactivité</dt>
              <dd class="tabular text-body text-ink">{{ idleEnd() }}</dd>
            </div>
            <div class="flex items-center justify-between gap-4 py-3 last:pb-0">
              <dt class="text-body-sm text-ink-muted">Fin de session au plus tard</dt>
              <dd class="tabular text-body text-ink">{{ absoluteEnd() }}</dd>
            </div>
          </dl>
        </rj-admin-panel>

        <rj-admin-panel title="Codes de secours" description="À utiliser si tu n’as plus accès à ton application d’authentification.">
          <p class="flex items-baseline gap-2">
            <span class="tabular text-metric font-semibold text-ink">{{ remaining() }}</span>
            <span class="text-body text-ink-muted">sur 10 encore utilisables</span>
          </p>
          @if (session.recoveryCodesLow()) {
            <rj-admin-alert tone="warn">Il te reste peu de codes. Génère-en de nouveaux ci-dessous.</rj-admin-alert>
          }
        </rj-admin-panel>
      </div>

      <rj-admin-panel
        title="Générer de nouveaux codes de secours"
        description="Les anciens codes cesseront de fonctionner. Saisis un code de ton application pour confirmer."
      >
        @if (codes(); as codes) {
          <rj-admin-alert tone="warn">Ces codes ne seront plus jamais affichés. Copie-les ou télécharge le fichier maintenant.</rj-admin-alert>
          <rj-recovery-codes-list [codes]="codes" class="max-w-xl" />
        } @else {
          @if (error(); as error) {
            <rj-admin-alert tone="danger">{{ error }}</rj-admin-alert>
          }
          <form class="flex max-w-md flex-col gap-4" (submit)="$event.preventDefault(); regenerate()" novalidate>
            <rj-otp-input [(value)]="code" [error]="codeError()" [disabled]="busy()" />
            <button type="submit" rjButton="secondary" icon="retry" [loading]="busy()" [disabled]="code().length !== 6" class="self-start">
              Générer de nouveaux codes
            </button>
          </form>
        }
      </rj-admin-panel>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminAccountSecurityPage {
  private readonly api = inject(AdminSecurityApi);
  protected readonly session = inject(AdminSessionStore);

  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly codeError = signal('');
  protected readonly error = signal('');
  protected readonly codes = signal<AdminRecoveryCodes | null>(null);

  protected readonly remaining = computed(() => this.session.recoveryCodesRemaining() ?? '—');
  protected readonly idleEnd = computed(() => {
    const end = this.session.expiresAt();
    return end ? formatTime(end) : '—';
  });
  protected readonly absoluteEnd = computed(() => {
    const end = this.session.status()?.absoluteExpiresAt;
    return end ? formatTime(end) : '—';
  });

  protected async regenerate(): Promise<void> {
    if (this.busy() || this.code().length !== 6) return;
    this.busy.set(true);
    this.codeError.set('');
    this.error.set('');
    try {
      this.codes.set(await this.api.regenerateRecoveryCodes(this.code()));
      // Le compteur de codes restants est relu (10 nouveaux codes).
      void this.session.ensureStatus(true);
    } catch (error) {
      const client = toClientError(error);
      this.code.set('');
      if (client.code === 'ADMIN_2FA_INVALID') this.codeError.set(client.message);
      else this.error.set(client.message);
    } finally {
      this.busy.set(false);
    }
  }
}
