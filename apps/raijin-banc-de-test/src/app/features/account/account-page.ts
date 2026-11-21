import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BenchBadge } from '../../shared/ui/bench-badge';
import { AuthStore } from '../../core/auth/auth-store';
import { createAttemptLock } from '../auth/attempt-lock';
import { NewPasswordForm } from '../auth/components/new-password-form';
import { PasswordField } from '../auth/components/password-field';

export const CURRENT_PASSWORD_ERROR = 'Mot de passe actuel incorrect';
export const CHANGE_ERROR_MESSAGE = 'Impossible de changer le mot de passe. Réessaie plus tard.';
export const CHANGE_SUCCESS_MESSAGE = 'Mot de passe modifié. Tes autres sessions ont été déconnectées.';

@Component({
  selector: 'app-account-page',
  imports: [BenchBadge, NewPasswordForm, PasswordField, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto max-w-sm px-safe pt-[calc(1.5rem+env(safe-area-inset-top))] pb-6">
      <div class="flex items-center justify-between gap-3">
        <a routerLink="/settings" class="btn-ghost min-h-11 px-3 text-sm">
          <span aria-hidden="true">←</span> Réglages
        </a>
        <app-bench-badge />
      </div>
      <h1 class="mt-6 text-2xl font-black tracking-tight">Mon compte</h1>
      @if (auth.email(); as email) {
        <p class="mt-1 truncate text-sm text-muted">Connecté : {{ email }}</p>
      }

      <section class="mt-8" aria-labelledby="change-password-title">
        <h2 id="change-password-title" class="text-lg font-bold">Changer le mot de passe</h2>
        @if (done()) {
          <p class="card mt-4 text-sm text-bull" role="status">{{ successMessage }}</p>
        } @else {
          <app-new-password-form [pending]="pending()" [error]="error()" [canSave]="canSave()" (save)="save($event)">
            <app-password-field
              fieldId="current-password"
              label="Mot de passe actuel"
              autocomplete="current-password"
              [(value)]="currentPassword"
            />
            @if (lockRemaining() > 0) {
              <p class="text-sm text-warn" role="status">Trop de tentatives. Réessaie dans {{ lockRemaining() }} s.</p>
            }
          </app-new-password-form>
        }
      </section>
    </main>
  `,
})
export class AccountPage {
  protected readonly auth = inject(AuthStore);

  protected readonly successMessage = CHANGE_SUCCESS_MESSAGE;

  private readonly lock = createAttemptLock();
  readonly lockRemaining = this.lock.lockRemaining;

  readonly currentPassword = signal('');
  readonly pending = signal(false);
  readonly error = signal<string | null>(null);
  readonly done = signal(false);
  readonly canSave = computed(() => this.lockRemaining() === 0 && this.currentPassword().length > 0);

  async save(newPassword: string): Promise<void> {
    if (this.pending() || !this.canSave()) return;
    this.pending.set(true);
    this.error.set(null);
    const result = await this.auth.changePassword(this.currentPassword(), newPassword);
    this.pending.set(false);
    switch (result) {
      case 'ok':
        this.lock.reset();
        this.currentPassword.set('');
        this.done.set(true);
        return;
      case 'wrong-current':
        // Generic on purpose: never show the raw Supabase error.
        this.error.set(CURRENT_PASSWORD_ERROR);
        this.currentPassword.set('');
        this.lock.fail();
        return;
      case 'update-failed':
        this.error.set(CHANGE_ERROR_MESSAGE);
        return;
    }
  }
}
