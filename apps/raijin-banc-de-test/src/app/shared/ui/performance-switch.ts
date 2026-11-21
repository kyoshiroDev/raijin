import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

export type PerformanceView = 'signals' | 'lab';

export const PERFORMANCE_VIEWS: readonly { id: PerformanceView; path: string; label: string }[] = [
  { id: 'signals', path: '/performance', label: 'Signaux' },
  { id: 'lab', path: '/performance/lab', label: 'Laboratoire' },
];

/**
 * Segmented control « Signaux | Laboratoire » at the top of the Performance screen. Real links (deep-linkable
 * /performance and /performance/lab), labelled <nav> + aria-current. 44 px targets.
 */
@Component({
  selector: 'app-performance-switch',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <nav aria-label="Vue des performances">
      <ul class="grid grid-cols-2 gap-1 rounded-xl border border-line bg-surface p-1">
        @for (v of views; track v.id) {
          <li>
            <a
              [routerLink]="v.path"
              [attr.aria-current]="active() === v.id ? 'page' : null"
              [attr.data-perf-view]="v.id"
              class="press flex min-h-11 items-center justify-center rounded-lg text-sm font-semibold transition-colors focus-visible:-outline-offset-2"
              [class]="active() === v.id ? 'seg-active' : 'text-muted hover:text-fg'"
              >{{ v.label }}</a
            >
          </li>
        }
      </ul>
    </nav>
  `,
})
export class PerformanceSwitch {
  readonly active = input.required<PerformanceView>();
  protected readonly views = PERFORMANCE_VIEWS;
}
