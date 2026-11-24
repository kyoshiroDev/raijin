import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { formatSignedSol, formatSolAmount } from '@raijin/bench-web-logic';
import { curveGeometry, curveSummary, type CurvePoint, formatDateTimeFr } from '@raijin/bench-web-logic/portfolio';

const WIDTH = 320;
const HEIGHT = 120;

let nextId = 0;

/**
 * Balance curve as an inline SVG (no chart library). role="img" + aria-label summary; the data stays available
 * as a small table (collapsed). Colours come from the theme tokens via currentColor.
 */
@Component({
  selector: 'app-balance-curve-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-2 p-3', 'data-balance-curve': '' },
  template: `
    @if (geometry(); as g) {
      <svg
        role="img"
        [attr.aria-label]="summary()"
        [attr.viewBox]="'0 0 ' + width + ' ' + height"
        preserveAspectRatio="none"
        class="h-32 w-full"
        [class.text-bull]="up()"
        [class.text-bear]="!up()"
      >
        <line x1="0" [attr.y1]="g.baseY" [attr.x2]="width" [attr.y2]="g.baseY" class="stroke-line" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke" />
        <path [attr.d]="g.area" fill="currentColor" fill-opacity="0.12" stroke="none" />
        <path [attr.d]="g.line" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="flex justify-between text-label text-muted tabular-nums slashed-zero">
        <span>Départ {{ sol(points()[0]!.balanceSol) }} SOL</span>
        <span>Plus bas {{ sol(g.min) }} · plus haut {{ sol(g.max) }}</span>
      </div>
    }
    <details class="text-xs">
      <summary class="flex min-h-11 cursor-pointer items-center text-muted">Voir les données de la courbe</summary>
      <table class="w-full tabular-nums slashed-zero" [attr.aria-labelledby]="uid">
        <caption [id]="uid" class="sr-only">Solde virtuel après chaque trade clôturé</caption>
        <thead>
          <tr class="text-left text-muted"><th scope="col" class="py-1 font-normal">Date</th><th scope="col" class="font-normal">Token</th><th scope="col" class="text-right font-normal">P&amp;L</th><th scope="col" class="text-right font-normal">Solde</th></tr>
        </thead>
        <tbody>
          @for (p of points(); track $index) {
            <tr class="border-t border-line" data-curve-row>
              <td class="py-1">{{ $index === 0 ? 'Départ' : date(p.at) }}</td>
              <td class="max-w-24 truncate">{{ p.symbol || '—' }}</td>
              <td class="text-right">{{ $index === 0 ? '–' : signed(p.pnlSol) }}</td>
              <td class="text-right">{{ sol(p.balanceSol) }} SOL</td>
            </tr>
          }
        </tbody>
      </table>
    </details>
  `,
})
export class BalanceCurveChart {
  readonly points = input.required<readonly CurvePoint[]>();

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;
  protected readonly uid = `balance-curve-${++nextId}`;
  protected readonly geometry = computed(() => curveGeometry(this.points(), WIDTH, HEIGHT));
  protected readonly summary = computed(() => curveSummary(this.points()));
  protected readonly up = computed(() => {
    const p = this.points();
    return p.length === 0 || p[p.length - 1]!.balanceSol >= p[0]!.balanceSol;
  });
  protected readonly sol = formatSolAmount;
  protected readonly signed = formatSignedSol;
  protected readonly date = formatDateTimeFr;
}
