import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { BenchBadge } from '../../shared/ui/bench-badge';
import { AuthStore } from '../../core/auth/auth-store';
import { isPlausibleEmail, normalizeEmail } from '../../shared/utils/email';
import { createAttemptLock } from './attempt-lock';
import { PasswordField } from './components/password-field';
import { Brand } from '../../shared/ui/brand';

export { LOCK_SECONDS, MAX_FAILED_ATTEMPTS } from './attempt-lock';
export const LOGIN_ERROR_MESSAGE = 'E-mail ou mot de passe incorrect';

@Component({
  selector: 'app-login-page',
  imports: [BenchBadge, Brand, PasswordField, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 safe-top safe-bottom">
      <app-bench-badge class="mb-4 self-start" />
      <h1 class="text-3xl font-black tracking-tight">
        <app-brand />
      </h1>
      <p class="mt-1 text-sm text-muted">Frappe avant l'éclair.</p>

      <form class="mt-8 space-y-4" (submit)="submit($event)">
        <div>
          <label for="email" class="text-sm text-muted">E-mail</label>
          <input
            id="email"
            name="email"
            type="email"
            class="field mt-1"
            autocomplete="email"
            inputmode="email"
            autocapitalize="off"
            required
            maxlength="254"
            [value]="email()"
            (input)="onEmail($event)"
          />
        </div>
        <app-password-field fieldId="password" label="Mot de passe" autocomplete="current-password" [(value)]="password" />
        @if (error(); as message) {
          <p class="text-sm text-bear" role="alert">{{ message }}</p>
        }
        @if (lockRemaining() > 0) {
          <p class="text-sm text-warn" role="status">
            Trop de tentatives. Réessaie dans {{ lockRemaining() }} s.
          </p>
        }
        <button type="submit" class="btn-primary w-full" [disabled]="!canSubmit()">
          {{ pending() ? 'Connexion…' : 'Se connecter' }}
        </button>
      </form>
      <a routerLink="/forgot-password" class="btn-ghost mt-3 w-full">Mot de passe oublié ?</a>

      <p class="mt-10 text-xs text-muted">
        Accès privé. Raijin-banc-de-test est un outil de test, pas un conseil en investissement.
      </p>
    </main>
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  readonly email = signal('');
  readonly password = signal('');
  readonly pending = signal(false);
  readonly error = signal<string | null>(null);
  private readonly lock = createAttemptLock();
  readonly failedAttempts = this.lock.failedAttempts;
  /** Seconds left before the submit button is unlocked (0 = not locked). */
  readonly lockRemaining = this.lock.lockRemaining;

  readonly canSubmit = computed(
    () =>
      !this.pending() && this.lockRemaining() === 0 && isPlausibleEmail(this.email()) && this.password().length > 0,
  );

  onEmail(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.pending.set(true);
    this.error.set(null);
    const ok = await this.auth.signInWithPassword(normalizeEmail(this.email()), this.password());
    this.pending.set(false);
    if (ok) {
      this.lock.reset();
      await this.router.navigateByUrl('/', { replaceUrl: true });
      return;
    }
    // Generic on purpose: never reveal whether the account exists, never show the raw error.
    this.error.set(LOGIN_ERROR_MESSAGE);
    this.password.set('');
    this.lock.fail();
  }
}
