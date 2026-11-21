import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { RjIcon } from '../icon/icon';
import { badgeText, type RjNavItem } from './nav-item';

/**
 * Barre d'onglets mobile (< 1024 px) : 4 entrées maximum, icône + libellé, cibles de 56 px,
 * safe area iOS en bas. `inline` sert à l'aperçu de la page /_design.
 */
@Component({
  selector: 'rj-tab-bar',
  imports: [RjIcon, RouterLink, RouterLinkActive],
  template: `
    <nav [attr.aria-label]="label()" [class]="classes()">
      <ul class="mx-auto flex max-w-lg">
        @for (item of visibleItems(); track item.path) {
          <li class="min-w-0 flex-1">
            <a
              [routerLink]="item.path"
              routerLinkActive
              #rla="routerLinkActive"
              ariaCurrentWhenActive="page"
              class="flex h-14 flex-col items-center justify-center gap-0.5 px-1 text-label font-medium transition-colors duration-150 ease-raijin focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
              [class.text-ink]="rla.isActive"
              [class.text-ink-muted]="!rla.isActive"
            >
              <span
                class="relative inline-flex h-7 w-14 items-center justify-center rounded-full transition-colors duration-200 ease-raijin"
                [class.bg-surface-raised]="rla.isActive"
              >
                <rj-icon [name]="item.icon" [size]="20" />
                @if (badge(item); as count) {
                  <span
                    class="tabular absolute top-0 right-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-label text-on-thunder"
                    aria-hidden="true"
                    >{{ count }}</span
                  >
                }
              </span>
              <span class="max-w-full truncate" [attr.title]="item.label">{{ item.label }}</span>
              @if (badge(item)) {
                <span class="sr-only">, {{ item.badge }} non lues</span>
              }
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjTabBar {
  readonly items = input.required<readonly RjNavItem[]>();
  readonly label = input('Navigation principale');
  readonly mode = input<'fixed' | 'inline'>('fixed');

  protected readonly visibleItems = computed(() => this.items().slice(0, 4));
  protected readonly classes = computed(() =>
    this.mode() === 'fixed'
      ? 'fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-safe lg:hidden'
      : 'block rounded-lg border border-line bg-surface',
  );

  protected badge(item: RjNavItem): string {
    return badgeText(item.badge);
  }
}
