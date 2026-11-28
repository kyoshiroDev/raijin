import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import type { PresetSegment } from '@raijin/bench-web-logic/performance';

/** Segmented control of one preset card (Tous / GTA / Hors GTA [/ < 3 h / 3–24 h]). Toggle buttons, 44 px targets. */
@Component({
  selector: 'app-preset-segment-selector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', role: 'group' },
  template: `
    <div class="grid gap-1 rounded-xl border border-line bg-surface p-1" [style.grid-template-columns]="'repeat(' + segments().length + ', minmax(0, 1fr))'">
      @for (s of segments(); track s.id) {
        <button
          type="button"
          class="press min-h-11 rounded-lg px-1 text-xs leading-tight font-semibold transition-colors focus-visible:-outline-offset-2"
          [class]="value() === s.id ? 'seg-active' : 'text-muted hover:text-fg'"
          [attr.aria-pressed]="value() === s.id"
          [attr.data-segment]="s.id"
          (click)="value.set(s.id)"
        >
          {{ s.label }}
        </button>
      }
    </div>
  `,
})
export class PresetSegmentSelector {
  readonly segments = input.required<readonly { id: PresetSegment; label: string }[]>();
  readonly value = model.required<PresetSegment>();
}
