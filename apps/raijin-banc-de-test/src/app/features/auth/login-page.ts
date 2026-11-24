import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { BenchLoginRequest } from '@raijin/bench-contracts';
import { recoveryCodeSchema, totpCodeSchema } from '@raijin/shared-contracts';
import { BenchBadge } from '../../shared/ui/bench-badge';
import { AuthStore, type SignInResult } from '../../core/auth/auth-store';
import { isPlausibleEmail, normalizeEmail } from '../../shared/utils/email';
import { createAttemptLock } from './attempt-lock';
import { PasswordField } from './components/password-field';
import { Brand } from '../../shared/ui/brand';

export { LOCK_SECONDS, MAX_FAILED_ATTEMPTS } from './attempt-lock';

export const LOGIN_MESSAGES: Readonly<Record<Exclude<SignInResult, 'ok'>, string>> = {
  // Une seule réponse pour l'e-mail, le mot de passe et le code : rien n'indique lequel est faux.
  invalid: 'E-mail, mot de passe ou code incorrect',
  throttled: 'Trop de tentatives. Réessaie dans quelques minutes.',
  error: 'Le banc ne répond pas. Réessaie dans un instant.',
};
export const LOGIN_ERROR_MESSAGE = LOGIN_MESSAGES.invalid;

export type SecondFactor = 'totp' | 'recovery';

/** Code saisi → valeur normalisée attendue par l'API, ou null tant qu'il n'a pas le bon format. */
export function normalizeSecondFactor(kind: SecondFactor, raw: string): string | null {
  const parsed = (kind === 'totp' ? totpCodeSchema : recoveryCodeSchema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Connexion du propriétaire du banc : e-mail + mot de passe + code de l'application d'authentification (TOTP), ou un
 * code de secours à usage unique. Aucune inscription ni réinitialisation par e-mail : mot de passe et 2FA se gèrent
 * par la CLI du conteneur (`set-password`, `reset-2fa`).
 */
@Component({
  selector: 'app-login-page',
  imports: [BenchBadge, Brand, PasswordField],
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
            autocomplete="username"
            inputmode="email"
            autocapitalize="off"
            required
            maxlength="254"
            [value]="email()"
            (input)="email.set(valueOf($event))"
          />
        </div>
        <app-password-field fieldId="password" label="Mot de passe" autocomplete="current-password" [(value)]="password" />
        <div>
          @if (factor() === 'totp') {
            <label for="code" class="text-sm text-muted">Code de l'application d'authentification</label>
            <input
              id="code"
              name="code"
              type="text"
              class="field mt-1 tabular-nums tracking-widest"
              autocomplete="one-time-code"
              inputmode="numeric"
              maxlength="7"
              required
              aria-describedby="code-help"
              [value]="code()"
              (input)="code.set(valueOf($event))"
            />
            <p id="code-help" class="mt-1 text-xs text-muted">6 chiffres, renouvelés toutes les 30 s.</p>
          } @else {
            <label for="code" class="text-sm text-muted">Code de secours</label>
            <input
              id="code"
              name="code"
              type="text"
              class="field mt-1 font-mono uppercase"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              maxlength="13"
              required
              aria-describedby="code-help"
              [value]="code()"
              (input)="code.set(valueOf($event))"
            />
            <p id="code-help" class="mt-1 text-xs text-muted">Format ABCDE-FGH23, utilisable une seule fois.</p>
          }
          <button type="button" class="btn-ghost mt-2 min-h-11 w-full text-sm" (click)="toggleFactor()">
            {{ factor() === 'totp' ? 'Utiliser un code de secours' : 'Utiliser le code de l’application' }}
          </button>
        </div>
        @if (error(); as message) {
          <p class="text-sm text-bear" role="alert">{{ message }}</p>
        }
        @if (lockRemaining() > 0) {
          <p class="text-sm text-warn" role="status">Trop de tentatives. Réessaie dans {{ lockRemaining() }} s.</p>
        }
        <button type="submit" class="btn-primary w-full" [disabled]="!canSubmit()">
          {{ pending() ? 'Connexion…' : 'Se connecter' }}
        </button>
      </form>

      <p class="mt-10 text-xs text-muted">
        Accès privé, compte unique. Raijin-banc-de-test est un outil de test, pas un conseil en investissement.
      </p>
    </main>
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  readonly email = signal('');
  readonly password = signal('');
  readonly code = signal('');
  readonly factor = signal<SecondFactor>('totp');
  readonly pending = signal(false);
  readonly error = signal<string | null>(null);
  private readonly lock = createAttemptLock();
  readonly failedAttempts = this.lock.failedAttempts;
  /** Seconds left before the submit button is unlocked (0 = not locked). */
  readonly lockRemaining = this.lock.lockRemaining;

  private readonly normalizedCode = computed(() => normalizeSecondFactor(this.factor(), this.code()));

  readonly canSubmit = computed(
    () =>
      !this.pending() &&
      this.lockRemaining() === 0 &&
      isPlausibleEmail(this.email()) &&
      this.password().length > 0 &&
      this.normalizedCode() !== null,
  );

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  toggleFactor(): void {
    this.factor.set(this.factor() === 'totp' ? 'recovery' : 'totp');
    this.code.set('');
    this.error.set(null);
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const code = this.normalizedCode();
    if (!this.canSubmit() || code === null) return;
    this.pending.set(true);
    this.error.set(null);
    const request: BenchLoginRequest = {
      email: normalizeEmail(this.email()),
      password: this.password(),
      ...(this.factor() === 'totp' ? { totp: code } : { recovery_code: code }),
    };
    const result = await this.auth.signIn(request);
    this.pending.set(false);
    if (result === 'ok') {
      this.lock.reset();
      await this.router.navigateByUrl('/', { replaceUrl: true });
      return;
    }
    // Générique : jamais le texte brut du serveur, jamais l'indication du champ faux.
    this.error.set(LOGIN_MESSAGES[result]);
    this.password.set('');
    this.code.set('');
    if (result === 'invalid') this.lock.fail();
  }
}
