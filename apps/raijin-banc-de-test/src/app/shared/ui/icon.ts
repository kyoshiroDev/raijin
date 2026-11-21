import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Raijin icon set: 24 × 24 viewBox, stroked with currentColor, stroke 2, round caps and joins.
 * Fixed path map (no external library, no dynamic markup): each icon is a list of path `d` strings.
 */
export const ICON_PATHS = {
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7l1-8Z'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  wallet: ['M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3', 'M21 12h-5a2 2 0 0 0 0 4h5v-4Z'],
  chart: ['M3 3v18h18', 'm7 15 4-4 3 3 6-6'],
  settings: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  refresh: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v4h-4'],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  copy: ['M9 11a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2Z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  check: ['m5 12 5 5 9-10'],
  minus: ['M5 12h14'],
  alert: ['M12 6v7', 'M12 17h.01'],
  warning: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z', 'M12 9v4', 'M12 17h.01'],
  info: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M12 11v5', 'M12 8h.01'],
  'chevron-right': ['m9 6 6 6-6 6'],
  'chevron-left': ['m15 6-6 6 6 6'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  'trend-up': ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'],
  share: ['M12 3v12', 'M8 7l4-4 4 4', 'M5 11v9h14v-9'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
  'eye-off': ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'M3 3l18 18'],
  'arrow-up': ['M12 19V5', 'm6 11 6-6 6 6'],
  'arrow-down': ['M12 5v14', 'm18 13-6 6-6-6'],
  clock: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M12 7v5l3 2'],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICON_PATHS;

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

/**
 * `<app-icon name="bell" class="size-5" />` — the size comes from the host class (the SVG fills it).
 * Decorative by default (aria-hidden). With `label`, it becomes a standalone image (role="img" + aria-label):
 * only for an icon that carries meaning on its own; inside a labelled button, keep it decorative.
 */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block shrink-0 align-middle', '[attr.data-icon]': 'name()' },
  template: `
    <svg
      viewBox="0 0 24 24"
      width="100%"
      height="100%"
      class="block"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      focusable="false"
      [attr.aria-hidden]="label() ? null : 'true'"
      [attr.role]="label() ? 'img' : null"
      [attr.aria-label]="label() || null"
    >
      @for (d of paths(); track $index) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  /** Accessible name when the icon stands alone; empty → decorative. */
  readonly label = input('');

  protected readonly paths = computed<readonly string[]>(() => ICON_PATHS[this.name()]);
}
