import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BOOK_SHORT_LABEL } from '../../../shared/models/paper';
import { formatPercentFr, formatSignedPercentFr, formatSignedSol, formatSolAmount } from '../../../shared/utils/format';
import { formatHits, formatRate, hasEnoughSample } from '../../performance/performance-stats';
import type { BookView } from '../paper-book';

interface Cell {
  text: string;
  /** Rate under 30 trades: grey « hits / n ». */
  insufficient: boolean;
}

interface Row {
  key: string;
  label: string;
  cells: Cell[];
}

const cell = (text: string, insufficient = false): Cell => ({ text, insufficient });

/** Leg-level TP rate (same definition as the strategy stats); « hits / n » in grey under 30 closed legs. */
function tpCell(v: BookView): Cell {
  const { tp, closed } = v.legs;
  return hasEnoughSample(closed) ? cell(formatRate(closed > 0 ? tp / closed : null)) : cell(formatHits(tp, closed), true);
}

/** Side-by-side comparison of the parallel books (the three test books, full stake each). */
@Component({
  selector: 'app-book-comparison',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-2 p-3', 'data-book-comparison': '' },
  template: `
    <table class="w-full text-xs tabular-nums slashed-zero">
      <caption class="sr-only">Comparaison des portefeuilles parallèles</caption>
      <thead>
        <tr class="text-muted">
          <th scope="col" class="py-1 text-left font-normal"><span class="sr-only">Indicateur</span></th>
          @for (b of books(); track b.book) {
            <th scope="col" class="pl-1 text-right align-bottom leading-tight font-semibold" [attr.data-compare-book]="b.book">
              {{ label[b.book] }}
            </th>
          }
        </tr>
      </thead>
      <tbody>
        @for (r of rows(); track r.key) {
          <tr class="border-t border-line" [attr.data-compare]="r.key">
            <th scope="row" class="py-1.5 text-left font-normal text-muted">{{ r.label }}</th>
            @for (c of r.cells; track $index) {
              <td class="pl-1 text-right" [class.text-muted]="c.insufficient" [attr.data-insufficient]="c.insufficient ? '' : null">
                {{ c.text }}
              </td>
            }
          </tr>
        }
      </tbody>
    </table>
    <p class="text-label text-muted">
      {{ note() }}
      @if (insufficient()) { En gris : échantillon insuffisant (moins de 30). }
    </p>
  `,
})
export class BookComparison {
  /** The books, in column order. */
  readonly books = input.required<readonly BookView[]>();
  /** Footnote describing how the books are fed. */
  readonly note = input('Mêmes alertes, mise complète dans chaque portefeuille. Taux de TP par jambe clôturée.');

  protected readonly label = BOOK_SHORT_LABEL;
  protected readonly insufficient = computed(() => this.books().some((v) => !hasEnoughSample(v.legs.closed)));
  protected readonly rows = computed<Row[]>(() => {
    const pair = (f: (v: BookView) => Cell): Cell[] => this.books().map(f);
    const dd = (v: BookView) => (v.drawdown.sol > 0 ? `−${formatPercentFr(v.drawdown.pct)}` : 'aucun');
    const pnl = (v: BookView): Cell => cell(`${formatSignedSol(v.totalPnlSol)} (${formatSignedPercentFr(v.totalPnlPct)})`);
    return [
      { key: 'balance', label: 'Solde', cells: pair((v) => cell(`${formatSolAmount(v.wallet.balance_sol)} SOL`)) },
      { key: 'pnl', label: 'P&L total', cells: pair(pnl) },
      { key: 'trades', label: 'Trades clôturés', cells: pair((v) => cell(String(v.trades))) },
      { key: 'tp', label: 'Taux de TP', cells: pair(tpCell) },
      { key: 'drawdown', label: 'Drawdown max', cells: pair((v) => cell(dd(v))) },
    ];
  });
}
