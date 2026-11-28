import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { BookProgress } from '@raijin/bench-web-logic/performance';

/** Progress of each test book towards its trade target (accessible progress bars). */
@Component({
  selector: 'app-test-books-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <ul class="space-y-2.5">
      @for (p of items(); track p.book) {
        <li class="space-y-1" [attr.data-progress]="p.book">
          <div class="flex items-baseline justify-between gap-2 text-xs">
            <span [id]="'progress-' + p.book" class="min-w-0 font-semibold">{{ p.label }}</span>
            <span class="shrink-0 tabular-nums slashed-zero" [class.text-bull]="p.done" [class.text-muted]="!p.done" data-progress-text>
              {{ p.text }}@if (p.done) { · objectif atteint }
            </span>
          </div>
          <div
            role="progressbar"
            class="h-2 overflow-hidden rounded-full bg-surface-2"
            aria-valuemin="0"
            [attr.aria-valuemax]="p.target"
            [attr.aria-valuenow]="p.value"
            [attr.aria-valuetext]="p.text"
            [attr.aria-labelledby]="'progress-' + p.book"
          >
            <div class="h-full rounded-full" [class.bg-bull]="p.done" [class.bg-fg]="!p.done" [style.width.%]="p.pct"></div>
          </div>
        </li>
      }
    </ul>
  `,
})
export class TestBooksProgress {
  readonly items = input.required<readonly BookProgress[]>();
}
