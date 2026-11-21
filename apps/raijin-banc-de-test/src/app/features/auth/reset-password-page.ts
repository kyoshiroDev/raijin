import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { BenchBadge } from '../../shared/ui/bench-badge';
import { AuthStore } from '../../core/auth/auth-store';
import { NewPasswordForm } from './components/new-password-form';
import { hasRecoveryError } from './recovery-url';

export const RECOVERY_TIMEOUT_MS = 10_000;
/**
 * Delay after the store is ready before treating a session without PASSWORD_RECOVERY as a
 * normal session (auth-js may deliver the event a few ticks after getSession() resolves).
 */
export const SESSION_SETTLE_MS = 1_000;
export const INVALID_LINK_MESSAGE = 'Lien invalide ou expiré';
export const UPDATE_ERROR_MESSAGE = 'Impossible de mettre à jour le mot de passe. Réessaie ou redemande un lien.';

type Status = 'waiting' | 'ready' | 'invalid';

/**
 * Reset form, unlocked ONLY by a PASSWORD_RECOVERY event received during this page load
 * (AuthStore.recoveryPending). An ordinary session never unlocks it: a signed-in user is sent
 * back to '/', and changes their password from /account (current password required).
 */
@Component({
  selector: 'app-reset-password-page',
  imports: [BenchBadge, NewPasswordForm, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 safe-top safe-bottom">
      <app-bench-badge class="mb-4 self-start" />
      <h1 class="text-2xl font-black tracking-tight">Nouveau mot de passe</h1>
      @switch (status()) {
        @case ('waiting') {
          <p class="mt-4 text-sm text-muted" role="status">Vérification du lien…</p>
        }
        @case ('invalid') {
          <div class="card mt-8" role="alert">
            <p class="font-semibold">{{ invalidMessage }}</p>
            <p class="mt-1 text-sm text-muted">Redemande un lien et ouvre-le dans ce même navigateur.</p>
          </div>
          <a routerLink="/forgot-password" class="btn-primary mt-4 w-full">Redemander un lien</a>
        }
        @case ('ready') {
          <app-new-password-form [pending]="pending()" [error]="error()" (save)="save($event)" />
        }
      }
    </main>
  `,
})
export class ResetPasswordPage {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly invalidMessage = INVALID_LINK_MESSAGE;

  private readonly urlError: boolean;
  private readonly timedOut = signal(false);
  /** Keeps the form on screen while redirecting after success (recoveryPending is cleared). */
  private readonly completed = signal(false);

  readonly status = computed<Status>(() => {
    if (this.urlError || this.timedOut()) return 'invalid';
    if (this.completed() || this.auth.recoveryPending()) return 'ready';
    return 'waiting';
  });
  readonly pending = signal(false);
  readonly error = signal<string | null>(null);

  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private destroyed = false;

  constructor() {
    const { search, hash } = inject(DOCUMENT).location;
    this.urlError = hasRecoveryError(search, hash);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.timers.forEach((t) => clearTimeout(t));
    });
    if (this.urlError || this.auth.recoveryPending()) return;

    // No session and no event within the timeout → invalid link.
    this.timers.push(setTimeout(() => this.decide(), RECOVERY_TIMEOUT_MS));
    // A normal session (no recovery event) is sent home without waiting the full timeout.
    void this.auth.whenReady().then(() => {
      if (this.destroyed) return;
      this.timers.push(
        setTimeout(() => {
          if (this.auth.isAuthenticated()) this.decide();
        }, SESSION_SETTLE_MS),
      );
    });
  }

  async save(password: string): Promise<void> {
    if (this.pending() || this.status() !== 'ready') return;
    this.pending.set(true);
    this.error.set(null);
    const updated = await this.auth.updatePassword(password);
    if (!updated) {
      this.pending.set(false);
      // Generic on purpose: never surface the raw Supabase error.
      this.error.set(UPDATE_ERROR_MESSAGE);
      return;
    }
    this.completed.set(true);
    await this.auth.signOutOtherSessions();
    this.pending.set(false);
    await this.router.navigateByUrl('/', { replaceUrl: true });
  }

  private decide(): void {
    if (this.destroyed || this.status() !== 'waiting') return;
    if (this.auth.isAuthenticated()) {
      void this.router.navigateByUrl('/', { replaceUrl: true });
    } else {
      this.timedOut.set(true);
    }
  }
}
