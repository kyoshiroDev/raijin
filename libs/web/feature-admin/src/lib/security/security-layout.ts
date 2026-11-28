import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { RjIcon, RjLogo } from '@raijin/web-ui';

/**
 * Écrans de sécurité admin (activation, code, codes de secours), hors coque : colonne centrée, logo et retour
 * au compte. 100dvh et zones sûres.
 */
@Component({
  selector: 'rj-admin-security-layout',
  imports: [RouterOutlet, RouterLink, RjIcon, RjLogo],
  template: `
    <header class="mx-auto flex h-16 w-full max-w-xl items-center justify-between gap-3 px-4 md:px-6">
      <span class="inline-flex items-center gap-2">
        <rj-logo variant="mark" [decorative]="true" />
        <span class="rounded-sm border border-line-strong px-1.5 py-0.5 text-label font-semibold tracking-wide text-ink-muted uppercase">Admin</span>
      </span>
      <a
        routerLink="/compte"
        class="-mr-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-body-sm font-medium text-ink-muted transition-colors duration-150 ease-raijin hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <rj-icon name="arrowLeft" [size]="16" />Mon compte
      </a>
    </header>
    <div class="mx-auto w-full max-w-xl px-4 pt-2 pb-12 md:px-6 md:pt-6">
      <div class="sm:rounded-lg sm:border sm:border-line sm:bg-surface sm:p-8">
        <router-outlet />
      </div>
    </div>
  `,
  host: { class: 'block min-h-dvh bg-base pt-safe pb-safe' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminSecurityLayout {}
