import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BenchBadge } from '../../shared/ui/bench-badge';
import { AuthStore } from '../../core/auth/auth-store';

const SESSION_END = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });

export const MODE_LABEL = {
  shadow: 'Mode ombre : collecte active, aucune notification envoyée',
  primary: 'Référence : le banc du VPS envoie les notifications',
} as const;

/**
 * Compte unique du banc : rappel de la session en cours. Mot de passe et double authentification se gèrent hors du
 * navigateur, par la CLI du conteneur (aucune route de changement ni de réinitialisation exposée par l'API).
 */
@Component({
  selector: 'app-account-page',
  imports: [BenchBadge, RouterLink],
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

      <section class="card mt-6 space-y-2 text-sm" aria-labelledby="session-title">
        <h2 id="session-title" class="text-base font-bold">Session</h2>
        @if (modeLabel(); as label) {
          <p data-mode>{{ label }}</p>
        }
        @if (sessionEnd(); as end) {
          <p class="text-muted">Fin de session au plus tard le {{ end }} (2 h sans activité, 12 h au maximum).</p>
        }
      </section>

      <section class="card mt-4 space-y-2 text-sm" aria-labelledby="security-title">
        <h2 id="security-title" class="text-base font-bold">Mot de passe et double authentification</h2>
        <p class="text-muted">
          Compte unique, sans inscription ni réinitialisation par e-mail. Le mot de passe, l'application
          d'authentification et les codes de secours se changent depuis le serveur, avec la CLI du conteneur
          (<code>set-password</code>, <code>reset-2fa</code>) : voir docs/BENCH.md.
        </p>
      </section>
    </main>
  `,
})
export class AccountPage {
  protected readonly auth = inject(AuthStore);

  readonly modeLabel = computed(() => {
    const mode = this.auth.mode();
    return mode === null ? null : MODE_LABEL[mode];
  });

  readonly sessionEnd = computed(() => {
    const at = this.auth.session()?.expiresAt;
    const ms = at ? Date.parse(at) : Number.NaN;
    return Number.isFinite(ms) ? SESSION_END.format(ms) : null;
  });
}
