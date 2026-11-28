import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { NARRATIVES, type LabNarrative, type NarrativeCounts } from '@raijin/bench-web-logic/strategy-lab';

/** Toggle buttons Tous / GTA / Hors GTA with the number of retained variants of each (44 px targets). */
@Component({
  selector: 'app-narrative-filter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', role: 'group', 'aria-label': 'Narratif' },
  template: `
    <div class="grid grid-cols-3 gap-1 rounded-xl border border-line bg-surface p-1">
      @for (n of narratives; track n.id) {
        <button
          type="button"
          class="press min-h-11 rounded-lg px-1 text-xs leading-tight font-semibold transition-colors focus-visible:-outline-offset-2"
          [class]="value() === n.id ? 'seg-active' : 'text-muted hover:text-fg'"
          [attr.aria-pressed]="value() === n.id"
          [attr.data-narrative]="n.id"
          (click)="value.set(n.id)"
        >
          {{ n.label }}
          @if (counts(); as c) {
            <span class="block text-micro font-normal">{{ c[n.id].retained }} retenue{{ c[n.id].retained > 1 ? 's' : '' }}</span>
          }
        </button>
      }
    </div>
  `,
})
export class NarrativeFilter {
  readonly value = model.required<LabNarrative>();
  readonly counts = input<Record<LabNarrative, NarrativeCounts> | null>(null);
  protected readonly narratives = NARRATIVES;
}
