import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ADMIN_PATHS, AdminSessionStore } from '@raijin/web-data-access';
import { RjBottomSheet, RjButton, RjErrorState, RjIcon, RjLogo, RjSkeleton, RjToastService, desktopViewport } from '@raijin/web-ui';
import { AdminIcons } from '../ui/admin-icons';
import { formatTime } from '../ui/format';
import { ADMIN_SCREENS, adminScreenLink, type AdminScreen } from './admin-screens';

const NAV_LINK =
  'flex min-h-11 items-center gap-3 rounded-md px-3 text-body font-medium text-ink-muted transition-colors duration-150 ease-raijin ' +
  'hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
const NAV_ACTIVE = '!bg-surface-raised !text-ink';
const CHIP =
  'inline-flex min-h-11 shrink-0 snap-start items-center gap-2 whitespace-nowrap rounded-full border border-line px-4 text-body-sm font-medium text-ink-muted ' +
  'transition-colors duration-150 ease-raijin hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
const CHIP_ACTIVE = '!border-line-strong !bg-surface-raised !text-ink';

/**
 * Coque de l'espace admin (thème sombre, PROMPT.md §4.7) : barre latérale des 9 écrans dès 1024 px ; en dessous,
 * barre du haut (menu en bottom sheet, « Quitter l'admin ») et rangée défilante des écrans. Le contenu n'est
 * rendu que si la session admin est vérifiée : à l'expiration, il disparaît avant la redirection.
 */
@Component({
  selector: 'rj-admin-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, RjBottomSheet, RjButton, RjErrorState, RjIcon, RjLogo, RjSkeleton],
  template: `
    @if (desktop() !== false) {
      <aside class="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-surface pt-safe lg:flex" aria-label="Espace admin">
        <div class="flex h-16 shrink-0 items-center gap-3 border-b border-line px-5">
          <a routerLink="/admin" class="inline-flex min-h-11 items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" aria-label="Raijin Shield Admin, vue d’ensemble">
            <rj-logo variant="wordmark" [decorative]="true" />
          </a>
          <span class="rounded-sm border border-line-strong px-1.5 py-0.5 text-label font-semibold tracking-wide text-ink-muted uppercase">Admin</span>
        </div>
        <nav aria-label="Écrans de l’admin" class="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <ul class="flex flex-col gap-1">
            @for (screen of screens; track screen.path) {
              <li>
                <a
                  [routerLink]="link(screen)"
                  routerLinkActive
                  #rla="routerLinkActive"
                  [routerLinkActiveOptions]="{ exact: screen.path === '' }"
                  ariaCurrentWhenActive="page"
                  [class]="navLink + (rla.isActive ? ' ' + navActive : '')"
                >
                  <rj-icon [name]="screen.icon" [size]="20" [class.text-thunder-ink]="rla.isActive" />
                  <span class="min-w-0">{{ screen.label }}</span>
                </a>
              </li>
            }
          </ul>
        </nav>
        <div class="flex shrink-0 flex-col gap-1 border-t border-line p-3 pb-safe">
          @if (expiresLabel(); as label) {
            <p class="flex items-center gap-2 px-3 py-1 text-label text-ink-muted">
              <rj-icon [name]="icons.lock" [size]="16" />{{ label }}
            </p>
          }
          <a
            [routerLink]="paths.accountSecurity"
            routerLinkActive
            #sec="routerLinkActive"
            ariaCurrentWhenActive="page"
            [class]="navLink + (sec.isActive ? ' ' + navActive : '')"
          >
            <rj-icon [name]="icons.shield" [size]="20" />
            <span class="min-w-0">Double authentification</span>
          </a>
          <button type="button" [class]="navLink + ' w-full'" [disabled]="leaving()" (click)="leave()">
            <rj-icon name="logout" [size]="20" />
            <span>Quitter l’admin</span>
          </button>
        </div>
      </aside>
    }

    <div class="flex min-h-dvh min-w-0 flex-col pb-safe lg:pl-64">
      @if (desktop() !== true) {
        <header class="sticky top-0 z-20 border-b border-line bg-base/95 pt-safe backdrop-blur lg:hidden">
          <div class="flex h-14 items-center gap-2 px-4 md:px-6">
            <a routerLink="/admin" class="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" aria-label="Raijin Shield Admin, vue d’ensemble">
              <rj-logo variant="mark" [decorative]="true" />
              <span class="rounded-sm border border-line-strong px-1.5 py-0.5 text-label font-semibold tracking-wide text-ink-muted uppercase">Admin</span>
            </a>
            <button
              type="button"
              class="ml-auto inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-body-sm font-medium text-ink transition-colors duration-150 ease-raijin hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              aria-haspopup="dialog"
              (click)="menuOpen.set(true)"
            >
              <rj-icon [name]="icons.menu" [size]="20" />
              Menu
            </button>
          </div>
          <nav aria-label="Écrans de l’admin" class="relative">
            <ul #chips class="flex snap-x scroll-px-4 gap-2 overflow-x-auto px-4 pb-3 [scrollbar-width:none] md:px-6">
              @for (screen of screens; track screen.path) {
                <li>
                  <a
                    [routerLink]="link(screen)"
                    routerLinkActive
                    #chip="routerLinkActive"
                    [routerLinkActiveOptions]="{ exact: screen.path === '' }"
                    ariaCurrentWhenActive="page"
                    [class]="chipClass + (chip.isActive ? ' ' + chipActive : '')"
                  >
                    <rj-icon [name]="screen.icon" [size]="16" [class.text-thunder-ink]="chip.isActive" />
                    {{ screen.label }}
                  </a>
                </li>
              }
            </ul>
          </nav>
        </header>
      }

      <div class="mx-auto w-full max-w-reading min-w-0 flex-1 px-4 pt-4 pb-12 md:px-6 md:pt-6 lg:px-8 lg:pt-8">
        @switch (view()) {
          @case ('ready') {
            <router-outlet />
          }
          @case ('error') {
            <rj-error-state
              title="Raijin n’a pas pu ouvrir l’espace admin"
              description="L’API ne répond pas. Vérifie ta connexion puis réessaie."
              [retrying]="retrying()"
              (retry)="retry()"
            />
          }
          @default {
            <div class="flex flex-col gap-4" role="status" aria-busy="true" aria-label="Chargement…">
              <rj-skeleton class="h-9 w-48" />
              <div class="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 xl:grid-cols-4">
                @for (item of [1, 2, 3, 4]; track item) {
                  <rj-skeleton shape="block" class="h-28" />
                }
              </div>
            </div>
          }
        }
      </div>
    </div>

    <rj-bottom-sheet [(open)]="menuOpen" title="Espace admin" desktop="panel">
      <nav aria-label="Écrans de l’admin (menu)">
        <ul class="flex flex-col gap-1">
          @for (screen of screens; track screen.path) {
            <li>
              <a
                [routerLink]="link(screen)"
                routerLinkActive
                #item="routerLinkActive"
                [routerLinkActiveOptions]="{ exact: screen.path === '' }"
                ariaCurrentWhenActive="page"
                [class]="navLink + (item.isActive ? ' ' + navActive : '')"
                (click)="menuOpen.set(false)"
              >
                <rj-icon [name]="screen.icon" [size]="20" [class.text-thunder-ink]="item.isActive" />
                {{ screen.label }}
              </a>
            </li>
          }
        </ul>
      </nav>
      <div class="mt-4 flex flex-col gap-1 border-t border-line pt-4">
        @if (expiresLabel(); as label) {
          <p class="flex items-center gap-2 px-3 py-1 text-label text-ink-muted"><rj-icon [name]="icons.lock" [size]="16" />{{ label }}</p>
        }
        <a [routerLink]="paths.accountSecurity" [class]="navLink" (click)="menuOpen.set(false)">
          <rj-icon [name]="icons.shield" [size]="20" />Double authentification
        </a>
      </div>
      <button rjSheetFooter type="button" rjButton="secondary" icon="logout" [block]="true" [loading]="leaving()" (click)="leave()">
        Quitter l’admin
      </button>
    </rj-bottom-sheet>
  `,
  host: { class: 'block min-h-dvh bg-base' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminShell {
  protected readonly session = inject(AdminSessionStore);
  private readonly router = inject(Router);
  private readonly toasts = inject(RjToastService);
  private readonly document = inject(DOCUMENT);
  private readonly chips = viewChild<ElementRef<HTMLElement>>('chips');

  protected readonly desktop = desktopViewport();
  protected readonly screens = ADMIN_SCREENS;
  protected readonly icons = AdminIcons;
  protected readonly paths = ADMIN_PATHS;
  protected readonly navLink = NAV_LINK;
  protected readonly navActive = NAV_ACTIVE;
  protected readonly chipClass = CHIP;
  protected readonly chipActive = CHIP_ACTIVE;
  protected readonly menuOpen = signal(false);
  protected readonly leaving = signal(false);
  protected readonly retrying = signal(false);

  protected readonly view = computed(() => {
    const state = this.session.state();
    if (state === 'error') return 'error';
    return this.session.verified() ? 'ready' : 'loading';
  });

  protected readonly expiresLabel = computed(() => {
    const end = this.session.expiresAt();
    return end ? `Session admin jusqu’à ${formatTime(end)}` : '';
  });

  constructor() {
    const injector = inject(Injector);
    // Rangée mobile : l'écran actif reste visible après chaque navigation.
    const reveal = () =>
      afterNextRender(
        () => {
          const active = this.chips()?.nativeElement.querySelector<HTMLElement>('[aria-current="page"]');
          const reduced = this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
          active?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
        },
        { injector },
      );
    reveal();
    const sub = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) reveal();
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  protected link(screen: AdminScreen): string {
    return adminScreenLink(screen);
  }

  protected async leave(): Promise<void> {
    this.leaving.set(true);
    this.menuOpen.set(false);
    try {
      await this.session.end();
      this.toasts.show('Tu as quitté l’espace admin.', { tone: 'success' });
    } catch {
      this.toasts.show('La sortie n’a pas été confirmée par le serveur. L’espace admin est fermé sur cet appareil.', { tone: 'info' });
    } finally {
      this.leaving.set(false);
    }
  }

  protected async retry(): Promise<void> {
    this.retrying.set(true);
    try {
      const state = await this.session.ensureStatus(true);
      if (state === 'not_found') this.session.showNotFound();
      else if (state === 'ready' && !this.session.verified()) {
        await this.router.navigateByUrl(this.session.enrolled() ? ADMIN_PATHS.verify : ADMIN_PATHS.enrollment);
      }
    } finally {
      this.retrying.set(false);
    }
  }
}
