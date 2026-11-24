import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ResolveEnd, Router, RouterOutlet, type ActivatedRouteSnapshot } from '@angular/router';
import { UnreadAlerts } from '@raijin/web-data-access';
import { RjAppShell, type RjNavItem } from '@raijin/web-ui';
import { RjShellBanners } from './shell-banners';

/** Entrées de la barre d'onglets (4 max, PROMPT.md §3) et du haut de la barre latérale. */
export const NAV_ITEMS: readonly RjNavItem[] = [
  { label: 'Analyser', path: '/analyse', icon: 'analyse' },
  { label: 'Suivis', path: '/suivis', icon: 'suivis' },
  { label: 'Alertes', path: '/alertes', icon: 'alertes' },
  { label: 'Compte', path: '/compte', icon: 'compte' },
];

/** Entrées visibles seulement dans la barre latérale desktop. */
export const SECONDARY_NAV_ITEMS: readonly RjNavItem[] = [
  { label: 'Scan de wallet', path: '/wallet', icon: 'wallet' },
];

/** Entrées de navigation avec le compteur d'alertes non lues sur « Alertes ». */
export function navItemsWithUnread(unread: number): readonly RjNavItem[] {
  return unread > 0 ? NAV_ITEMS.map((item) => (item.path === '/alertes' ? { ...item, badge: unread } : item)) : NAV_ITEMS;
}

/** Vrai si une route active déclare `data: { appChrome: false }` (espace admin : coque propre). */
export function hidesAppChrome(snapshot: ActivatedRouteSnapshot | null): boolean {
  for (let route = snapshot; route; route = route.firstChild) {
    if (route.data['appChrome'] === false) return true;
  }
  return false;
}

/** Coquille de l'app : volontairement fine, la mise en page vit dans @raijin/web-ui. */
@Component({
  selector: 'rj-root',
  imports: [RouterOutlet, RjAppShell, RjShellBanners],
  template: `
    <rj-app-shell
      [chrome]="appChrome()"
      [items]="navItems()"
      [secondaryItems]="secondaryItems"
      [notificationCount]="unread.count()"
      (notifications)="openAlerts()"
    >
      <!-- Bandeaux « hors ligne » et d'essai Pro : chunk à part, chargé quand le navigateur est inactif (hors chemin du LCP). -->
      <div rjShellBanners class="mx-auto w-full max-w-reading px-4 md:px-6 lg:px-8">
        @if (appChrome()) {
          @defer (on idle) {
            <rj-shell-banners />
          }
        }
      </div>
      <router-outlet />
    </rj-app-shell>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly router = inject(Router);
  protected readonly unread = inject(UnreadAlerts);
  protected readonly navItems = computed(() => navItemsWithUnread(this.unread.count()));
  protected readonly secondaryItems = SECONDARY_NAV_ITEMS;

  /** Barre d'onglets, barre latérale et en-tête de l'app ; masqués dans l'espace admin. */
  protected readonly appChrome = signal(true);

  constructor() {
    // Décidé avant l'activation de la route (`ResolveEnd`) : pas d'en-tête de l'app affiché un instant sur /admin.
    const sub = this.router.events.subscribe((event) => {
      if (event instanceof ResolveEnd) this.appChrome.set(!hidesAppChrome(event.state.root));
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
    // Badge des alertes : première lecture après le premier rendu de la route (hors chemin du LCP).
    this.unread.startAfterFirstRoute();
  }

  protected openAlerts(): void {
    void this.router.navigateByUrl('/alertes');
  }
}
