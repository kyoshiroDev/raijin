import { ChangeDetectionStrategy, Component, computed, inject, type Signal } from '@angular/core';
import { Router, RouterLink, isActive, type IsActiveMatchOptions } from '@angular/router';
import { Icon, type IconName } from '../../shared/ui/icon';

export interface NavTab {
  path: string;
  label: string;
  /** Icon of the shared set (shared/ui/icon.ts). */
  icon: IconName;
  exact: boolean;
  /** Shorter label shown below 360 px, where the full one would be truncated (still a visible text name). */
  short?: string;
}

export const NAV_TABS: readonly NavTab[] = [
  { path: '/', label: 'Opportunités', short: 'Tokens', icon: 'bolt', exact: true },
  { path: '/alerts', label: 'Alertes', icon: 'bell', exact: false },
  { path: '/portfolio', label: 'Portefeuille', icon: 'wallet', exact: false },
  { path: '/performance', label: 'Performance', short: 'Bilan', icon: 'chart', exact: false },
  { path: '/settings', label: 'Réglages', icon: 'settings', exact: false },
];

const EXACT: IsActiveMatchOptions = { paths: 'exact', queryParams: 'ignored', fragment: 'ignored', matrixParams: 'ignored' };
const SUBSET: IsActiveMatchOptions = { paths: 'subset', queryParams: 'ignored', fragment: 'ignored', matrixParams: 'ignored' };

/**
 * Fixed tab bar sitting above the iPhone home indicator. 5 tabs (the iOS maximum): at 375 px each column is
 * 75 px wide × 56 px tall (≥ 44 px targets); 10 px labels fit (« Opportunités » ≈ 66 px of 71 px usable) and truncate otherwise; at 320 px (64 px columns) « Opportunités » and « Performance » give way to « Tokens » and « Bilan ».
 */
@Component({
  selector: 'app-bottom-nav',
  imports: [Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'fixed inset-x-0 bottom-0 z-30 block border-t border-line bg-base/95 backdrop-blur safe-bottom safe-x' },
  template: `
    <nav aria-label="Navigation principale" class="mx-auto max-w-lg">
      <ul class="grid grid-cols-5">
        @for (tab of tabs; track tab.path; let i = $index) {
          @let current = active()[i];
          <li>
            <a
              [routerLink]="tab.path"
              [class.active]="current"
              [attr.aria-current]="current ? 'page' : null"
              class="flex h-nav min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl text-micro font-semibold tracking-tight text-muted transition-colors hover:text-fg focus-visible:-outline-offset-2 aria-[current=page]:text-accent"
            >
              <app-icon [name]="tab.icon" class="size-6" />
              @if (tab.short) {
                <span class="max-w-full truncate px-0.5 min-[360px]:hidden">{{ tab.short }}</span>
                <span class="hidden max-w-full truncate px-0.5 min-[360px]:inline">{{ tab.label }}</span>
              } @else {
                <span class="max-w-full truncate px-0.5">{{ tab.label }}</span>
              }
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
})
export class BottomNav {
  private readonly router = inject(Router);
  protected readonly tabs = NAV_TABS;

  /** One signal per tab: its own path (exact or prefix). */
  private readonly tabActive: readonly Signal<boolean>[] = NAV_TABS.map((tab) =>
    isActive(tab.path, this.router, tab.exact ? EXACT : SUBSET),
  );
  protected readonly active = computed(() => this.tabActive.map((s) => s()));
}

