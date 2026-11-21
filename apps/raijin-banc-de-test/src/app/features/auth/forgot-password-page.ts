import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BenchBadge } from '../../shared/ui/bench-badge';
import { AuthStore } from '../../core/auth/auth-store';
import { isPlausibleEmail, normalizeEmail } from '../../shared/utils/email';

export const RESET_SENT_MESSAGE =
  "Si ce compte existe, un lien de réinitialisation vient d'être envoyé. Ouvre-le dans ce même navigateur.";

@Component({
  selector: 'app-forgot-password-page',
  imports: [BenchBadge, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 safe-top safe-bottom">
      <app-bench-badge class="mb-4 self-start" />
      <h1 class="text-2xl font-black tracking-tight">Mot de passe oublié</h1>

      @if (sent()) {
        <p class="card mt-8 text-sm" role="status">{{ message }}</p>
      } @else {
        <p class="mt-1 text-sm text-muted">Saisis ton e-mail pour recevoir un lien de réinitialisation.</p>
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
          <button type="submit" class="btn-primary w-full" [disabled]="!canSubmit()">
            {{ pending() ? 'Envoi…' : 'Envoyer le lien' }}
          </button>
        </form>
      }
      <a routerLink="/login" class="btn-ghost mt-3 w-full">Retour à la connexion</a>
    </main>
  `,
})
export class ForgotPasswordPage {
  private readonly auth = inject(AuthStore);

  protected readonly message = RESET_SENT_MESSAGE;

  readonly email = signal('');
  readonly pending = signal(false);
  readonly sent = signal(false);
  readonly canSubmit = computed(() => !this.pending() && isPlausibleEmail(this.email()));

  onEmail(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.pending.set(true);
    try {
      await this.auth.requestPasswordReset(normalizeEmail(this.email()));
    } catch {
      // Same message whatever happens: never reveal whether an account exists.
    } finally {
      this.pending.set(false);
      this.sent.set(true);
    }
  }
}
