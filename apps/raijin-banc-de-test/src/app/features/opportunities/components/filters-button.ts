import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { Icon } from '../../../shared/ui/icon';

@Component({
  selector: 'app-filters-button',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'shrink-0' },
  template: `
    <button
      type="button"
      class="btn-ghost px-3"
      aria-haspopup="dialog"
      [attr.aria-label]="ariaLabel()"
      (click)="activate.emit()"
    >
      <app-icon name="filter" class="size-4" />
      Filtres
      @if (count() > 0) {
        <span data-filter-badge class="grid h-5 min-w-5 place-items-center rounded-full bg-fg px-1 text-label font-bold text-base tabular-nums slashed-zero" aria-hidden="true">
          {{ count() }}
        </span>
      }
    </button>
  `,
})
export class FiltersButton {
  readonly count = input(0);
  readonly activate = output<void>();

  protected readonly ariaLabel = computed(() => {
    const n = this.count();
    return n === 0 ? 'Filtres' : `Filtres, ${n} actif${n > 1 ? 's' : ''}`;
  });
}
