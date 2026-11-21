import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { RjIcon } from '../icon/icon';
import { RjLogo } from '../logo/logo';
import { RjToastHost } from '../toast/toast';
import { badgeText, type RjNavItem } from './nav-item';
import { RjSidebar } from './sidebar';
import { RjTabBar } from './tab-bar';

const COLLAPSE_KEY = 'rj.sidebar.collapsed';

/**
 * Coquille de l'app : header compact (logo, notifications), barre d'onglets en bas sous 1024 px,
 * barre latérale au-delà, contenu centré (1200 px max, marges 16/24/32), 100dvh et safe areas.
 */
@Component({
  selector: 'rj-app-shell',
  imports: [RjIcon, RjLogo, RjSidebar, RjTabBar, RjToastHost, RouterLink],
  template: `
    <a
      href="#rj-main"
      class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-4 focus:py-3 focus:text-ink"
      (click)="skipToMain($event)"
      >Aller au contenu</a
    >
    <rj-sidebar [items]="items()" [secondaryItems]="secondaryItems()" [(collapsed)]="collapsed" />
    <div [class]="columnClasses()">
      <header class="sticky top-0 z-20 border-b border-line bg-base pt-safe">
        <div class="mx-auto flex h-14 max-w-reading items-center gap-3 px-4 md:px-6 lg:px-8">
          <a
            routerLink="/"
            class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring lg:hidden"
            aria-label="Raijin Shield, accueil"
          >
            <rj-logo [decorative]="true" />
          </a>
          <button
            type="button"
            class="relative ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 ease-raijin hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            [attr.aria-label]="notificationsLabel()"
            (click)="notifications.emit()"
          >
            <rj-icon name="bell" [size]="20" />
            @if (notificationBadge(); as count) {
              <span
                aria-hidden="true"
                class="tabular absolute top-1.5 right-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-label text-on-thunder"
                >{{ count }}</span
              >
            }
          </button>
        </div>
      </header>
      <main id="rj-main" tabindex="-1" class="mx-auto w-full max-w-reading px-4 pt-4 pb-tabbar focus:outline-none md:px-6 md:pt-6 lg:px-8 lg:pt-8 lg:pb-12">
        <ng-content />
      </main>
    </div>
    <rj-tab-bar [items]="items()" />
    <rj-toast-host />
  `,
  host: { class: 'block min-h-dvh bg-base pl-safe pr-safe' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAppShell {
  private readonly document = inject(DOCUMENT);

  /** Entrées principales : barre d'onglets (4 max) et haut de la barre latérale. */
  readonly items = input.required<readonly RjNavItem[]>();
  /** Entrées secondaires, visibles seulement dans la barre latérale desktop. */
  readonly secondaryItems = input<readonly RjNavItem[]>([]);
  readonly notificationCount = input(0);
  readonly notifications = output<void>();

  protected readonly collapsed = signal(this.readCollapsed());
  protected readonly notificationBadge = computed(() => badgeText(this.notificationCount()));
  protected readonly notificationsLabel = computed(() => {
    const count = this.notificationCount();
    return count > 0 ? `Notifications, ${count} non lues` : 'Notifications';
  });
  protected readonly columnClasses = computed(
    () =>
      `flex min-h-dvh min-w-0 flex-col transition-[padding] duration-200 ease-raijin ${this.collapsed() ? 'lg:pl-18' : 'lg:pl-60'}`,
  );

  constructor() {
    effect(() => {
      const value = this.collapsed();
      try {
        this.document.defaultView?.localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0');
      } catch {
        // Stockage indisponible (navigation privée) : la préférence reste en mémoire.
      }
    });
  }

  protected skipToMain(event: Event): void {
    event.preventDefault();
    this.document.getElementById('rj-main')?.focus();
  }

  private readCollapsed(): boolean {
    try {
      return this.document.defaultView?.localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  }
}
