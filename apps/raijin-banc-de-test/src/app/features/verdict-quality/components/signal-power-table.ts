import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { ANALYSIS_CHECK_LABELS, type AnalysisCheckId } from '@raijin/shared-contracts';
import type { SignalPowerRow } from '@raijin/bench-verdicts';
import { formatLift } from '@raijin/bench-web-logic/verdict-quality';
import { ProportionValue } from './proportion-value';

/** Pouvoir prédictif des signaux (raisons ou contrôles) : cartes < 768 px, tableau au-delà. */
@Component({
  selector: 'app-signal-power-table',
  imports: [ProportionValue],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block space-y-2' },
  template: `
    <h3 class="text-sm font-semibold">{{ caption() }}</h3>
    @if (rows().length === 0) {
      <p class="card text-sm text-muted" data-signals-empty>Aucun signal porté par les verdicts évalués.</p>
    } @else {
      <ul class="space-y-2 md:hidden" [attr.aria-label]="caption()">
        @for (row of rows(); track row.signal) {
          <li class="card space-y-2" data-signal-card [attr.data-signal]="row.signal">
            <div class="flex items-start justify-between gap-2">
              <span class="font-mono text-xs break-all">{{ label(row) }}</span>
              <span class="shrink-0 text-sm font-bold" [class.text-muted]="!row.ranked">{{ lift(row.lift) }}</span>
            </div>
            <p class="text-xs text-muted">{{ row.support }} porteurs</p>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <p class="text-label text-muted">Taux de rug avec</p>
                <app-proportion-value [p]="row.withSignal" [minSample]="minSample()" [compact]="true" />
              </div>
              <div>
                <p class="text-label text-muted">Sans</p>
                <app-proportion-value [p]="row.withoutSignal" [minSample]="minSample()" [compact]="true" />
              </div>
            </div>
          </li>
        }
      </ul>
      <div class="hidden overflow-x-auto md:block">
        <table class="w-full text-left text-sm" data-signal-table>
          <caption class="sr-only">{{ caption() }}</caption>
          <thead class="text-xs text-muted">
            <tr>
              <th scope="col" class="py-2 pr-3 font-semibold">Signal</th>
              <th scope="col" class="py-2 pr-3 font-semibold">Porteurs</th>
              <th scope="col" class="py-2 pr-3 font-semibold">Taux de rug avec</th>
              <th scope="col" class="py-2 pr-3 font-semibold">Sans</th>
              <th scope="col" class="py-2 font-semibold">Lift</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.signal) {
              <tr class="border-t border-line align-top" [attr.data-signal]="row.signal">
                <th scope="row" class="py-2 pr-3 font-mono text-xs font-normal break-all">{{ label(row) }}</th>
                <td class="py-2 pr-3 tabular-nums">{{ row.support }}</td>
                <td class="py-2 pr-3"><app-proportion-value [p]="row.withSignal" [minSample]="minSample()" [compact]="true" /></td>
                <td class="py-2 pr-3"><app-proportion-value [p]="row.withoutSignal" [minSample]="minSample()" [compact]="true" /></td>
                <td class="py-2 font-bold tabular-nums" [class.text-muted]="!row.ranked">{{ lift(row.lift) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class SignalPowerTable {
  readonly rows = input.required<readonly SignalPowerRow[]>();
  readonly caption = input.required<string>();
  readonly minSample = input(30);
  protected readonly lift = formatLift;

  protected label(row: SignalPowerRow): string {
    return row.kind === 'check' ? (ANALYSIS_CHECK_LABELS[row.signal as AnalysisCheckId] ?? row.signal) : row.signal;
  }
}
