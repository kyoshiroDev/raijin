import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { BookComparisonView } from '@raijin/bench-web-logic/performance';

/** Table of the three test books (one column each). Rates under 30 trades: « hits / n » in grey, never prominent. */
@Component({
  selector: 'app-test-books-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @let v = view();
    <table class="w-full text-xs tabular-nums slashed-zero">
      <caption class="sr-only">Comparaison des trois portefeuilles de test</caption>
      <thead>
        <tr class="text-muted">
          <th scope="col" class="py-1 text-left font-normal"><span class="sr-only">Indicateur</span></th>
          @for (c of v.columns; track c.book) {
            <th scope="col" class="pl-1 text-right align-bottom leading-tight font-semibold text-fg" [attr.data-compare-book]="c.book">
              {{ c.label }}
              @if (c.control) { <span class="block text-label font-normal text-muted">témoin</span> }
            </th>
          }
        </tr>
      </thead>
      <tbody>
        @for (r of v.rows; track r.key) {
          <tr class="border-t border-line" [attr.data-compare]="r.key">
            <th scope="row" class="py-1.5 pr-1 text-left font-normal text-muted">{{ r.label }}</th>
            @for (cell of r.cells; track $index) {
              <td
                class="pl-1 text-right"
                [class.text-muted]="cell.muted"
                [class.font-semibold]="!cell.muted"
                [class.text-bull]="cell.tone === 'bull'"
                [class.text-bear]="cell.tone === 'bear'"
                [attr.data-insufficient]="cell.muted ? '' : null"
              >
                {{ cell.text }}
                @if (cell.sub) { <span class="block text-label font-normal text-muted">{{ cell.sub }}</span> }
              </td>
            }
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class TestBooksTable {
  readonly view = input.required<BookComparisonView>();
}
