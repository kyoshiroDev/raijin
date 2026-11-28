import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PanelLeftClose, PanelLeftOpen } from 'lucide';
import { RjIcon } from '../icon/icon';
import { RjLogo } from '../logo/logo';
import { badgeText, currentPath, isNavItemActive, type RjNavItem } from './nav-item';

/**
 * Barre latérale desktop (≥ 1024 px) : 240 px, repliable à 72 px. Repliée, les libellés restent
 * lisibles par les lecteurs d'écran et en `title`, et chaque icône garde une cible de 44 px.
 */
@Component({
  selector: 'rj-sidebar',
  imports: [RjIcon, RjLogo, RouterLink],
  template: `
    <aside [class]="classes()">
      <div class="flex h-14 shrink-0 items-center border-b border-line" [class.px-5]="!collapsed()" [class.justify-center]="collapsed()">
        <a
          routerLink="/"
          class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          aria-label="Raijin Shield, accueil"
        >
          <rj-logo [variant]="collapsed() ? 'mark' : 'wordmark'" [decorative]="true" />
        </a>
      </div>
      <nav [attr.aria-label]="label()" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-2">
        @for (group of groups(); track $index) {
          @if (group.length) {
            <ul class="flex flex-col gap-1" [class.border-t]="$index > 0" [class.border-line]="$index > 0" [class.pt-4]="$index > 0">
              @for (item of group; track item.path) {
                @let active = isActive(item, path());
                <li>
                  <a
                    [routerLink]="item.path"
                    [attr.aria-current]="active ? 'page' : null"
                    [attr.title]="collapsed() ? item.label : null"
                    class="relative flex min-h-11 items-center gap-3 rounded-md text-body font-medium transition-colors duration-150 ease-raijin hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    [class.px-3]="!collapsed()"
                    [class.justify-center]="collapsed()"
                    [class.bg-surface-raised]="active"
                    [class.text-ink]="active"
                    [class.text-ink-muted]="!active"
                  >
                    <rj-icon [name]="item.icon" [size]="20" />
                    <span [class.sr-only]="collapsed()" [attr.title]="collapsed() ? null : item.label" class="min-w-0 flex-1 truncate">{{ item.label }}@if (badge(item)) {<span class="sr-only">, {{ item.badge }} non lues</span>}</span>
                    @if (badge(item); as count) {
                      <span
                        aria-hidden="true"
                        class="tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-label text-on-thunder"
                        [class.absolute]="collapsed()"
                        [class.top-1]="collapsed()"
                        [class.right-1]="collapsed()"
                        >{{ count }}</span
                      >
                    }
                  </a>
                </li>
              }
            </ul>
          }
        }
      </nav>
      <div class="shrink-0 border-t border-line p-3 pb-safe">
        <button
          type="button"
          class="flex min-h-11 w-full items-center gap-3 rounded-md text-body font-medium text-ink-muted transition-colors duration-150 ease-raijin hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          [class.px-3]="!collapsed()"
          [class.justify-center]="collapsed()"
          [attr.aria-expanded]="!collapsed()"
          [attr.aria-label]="collapsed() ? 'Déplier le menu' : 'Replier le menu'"
          (click)="collapsed.set(!collapsed())"
        >
          <rj-icon [name]="collapsed() ? expandIcon : collapseIcon" [size]="20" />
          @if (!collapsed()) {
            <span>Replier</span>
          }
        </button>
      </div>
    </aside>
  `,
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjSidebar {
  readonly items = input.required<readonly RjNavItem[]>();
  readonly secondaryItems = input<readonly RjNavItem[]>([]);
  readonly collapsed = model(false);
  readonly label = input('Navigation principale');
  readonly mode = input<'fixed' | 'inline'>('fixed');

  // Nœuds Lucide importés ici : ils suivent la barre latérale dans son chunk différé (§10.6, G2/G3).
  protected readonly expandIcon = PanelLeftOpen;
  protected readonly collapseIcon = PanelLeftClose;
  protected readonly path = currentPath();
  protected readonly isActive = isNavItemActive;
  protected readonly groups = computed(() => [this.items(), this.secondaryItems()]);
  protected readonly classes = computed(() =>
    [
      'flex-col overflow-hidden border-line bg-surface transition-[width] duration-200 ease-raijin',
      this.collapsed() ? 'w-18' : 'w-60',
      this.mode() === 'fixed'
        ? 'fixed inset-y-0 left-0 z-30 hidden border-r pt-safe lg:flex'
        : 'flex h-full min-h-96 rounded-lg border',
    ].join(' '),
  );

  protected badge(item: RjNavItem): string {
    return badgeText(item.badge);
  }
}
