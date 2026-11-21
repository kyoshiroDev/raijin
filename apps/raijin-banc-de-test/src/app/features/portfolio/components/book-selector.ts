import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { BOOK_SHORT_LABEL, type PaperBook } from '../../../shared/models/paper';

/** Segmented control between the virtual books (shown only when parallel books exist). 44 px targets, 2 columns beyond 3. */
@Component({
  selector: 'app-book-selector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', role: 'group', 'aria-label': 'Portefeuille virtuel affiché' },
  template: `
    <div class="grid gap-1 rounded-xl bg-surface-2 p-1" [style.grid-template-columns]="'repeat(' + columns() + ', minmax(0, 1fr))'">
      @for (b of books(); track b) {
        <button
          type="button"
          class="min-h-11 rounded-lg px-2 text-xs leading-tight font-semibold"
          [class.bg-surface]="value() === b"
          [class.text-fg]="value() === b"
          [class.shadow]="value() === b"
          [class.text-muted]="value() !== b"
          [attr.aria-pressed]="value() === b"
          [attr.data-book]="b"
          (click)="value.set(b)"
        >
          {{ label[b] }}
        </button>
      }
    </div>
  `,
})
export class BookSelector {
  readonly books = input.required<readonly PaperBook[]>();
  readonly value = model.required<PaperBook>();

  protected readonly label = BOOK_SHORT_LABEL;
  /** One row up to 3 books; beyond (main + the 3 test books, + archived ones), 2 columns. */
  protected readonly columns = computed(() => (this.books().length <= 3 ? this.books().length : 2));
}
