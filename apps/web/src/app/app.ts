import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { UnreadAlerts } from '@raijin/web-data-access';
import { RjAppShell, type RjNavItem } from '@raijin/web-ui';

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

/** Coquille de l'app : volontairement fine, la mise en page vit dans @raijin/web-ui. */
@Component({
  selector: 'rj-root',
  imports: [RouterOutlet, RjAppShell],
  template: `
    <rj-app-shell
      [items]="navItems()"
      [secondaryItems]="secondaryItems"
      [notificationCount]="unread.count()"
      (notifications)="openAlerts()"
    >
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

  constructor() {
    // Badge des alertes : première lecture après le premier rendu de la route (hors chemin du LCP).
    this.unread.startAfterFirstRoute();
  }

  protected openAlerts(): void {
    void this.router.navigateByUrl('/alertes');
  }
}
