import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
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

/** Coquille de l'app : volontairement fine, la mise en page vit dans @raijin/web-ui. */
@Component({
  selector: 'rj-root',
  imports: [RouterOutlet, RjAppShell],
  template: `
    <rj-app-shell [items]="navItems" [secondaryItems]="secondaryItems" (notifications)="openAlerts()">
      <router-outlet />
    </rj-app-shell>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly router = inject(Router);
  protected readonly navItems = NAV_ITEMS;
  protected readonly secondaryItems = SECONDARY_NAV_ITEMS;

  protected openAlerts(): void {
    void this.router.navigateByUrl('/alertes');
  }
}
