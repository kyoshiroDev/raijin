import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MIN_SAMPLE_FOR_RATE, comparisonRows, type ComparisonView, type PresetSegment } from '@raijin/bench-web-logic/performance';
import { PresetSegmentSelector } from './preset-segment-selector';

/**
 * « Calme vs Frénésie »: presets young_calm and young_frenzy side by side for one shared segment (Tous / GTA /
 * Hors GTA). Rates are prominent only from 30 labelled signals; below that, « hits / n » in grey.
 */
@Component({
  selector: 'app-calm-frenzy-card',
  imports: [PresetSegmentSelector],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-3 p-3', 'data-calm-frenzy-card': '' },
  template: `
    @let v = view();
    <h3 class="text-sm font-bold">Calme vs Frénésie</h3>
    <app-preset-segment-selector
      aria-label="Segment · Calme vs Frénésie"
      [segments]="v.segments"
      [value]="v.segment"
      (valueChange)="segmentChange.emit($event)"
    />
    @if (v.hasData) {
      <table class="w-full text-xs tabular-nums slashed-zero">
        <caption class="sr-only">Comparaison des profils Calme et Frénésie</caption>
        <thead>
          <tr class="text-muted">
            <th scope="col" class="py-1 text-left font-normal"><span class="sr-only">Indicateur</span></th>
            @for (c of v.columns; track c.preset) {
              <th scope="col" class="pl-2 text-right font-semibold text-fg" [attr.data-compare-preset]="c.preset">{{ c.label }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @for (r of rows(); track r.key) {
            <tr class="border-t border-line" [attr.data-compare]="r.key">
              <th scope="row" class="py-1.5 text-left font-normal text-muted">{{ r.label }}</th>
              @for (cell of r.cells; track $index) {
                <td
                  class="pl-2 text-right"
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
    } @else {
      <p class="text-sm text-muted" data-empty-comparison>Aucun signal pour ce segment pour l’instant.</p>
    }
    <p class="text-label text-muted">
      Jeunes paires PumpSwap (&lt; 24 h), mêmes filtres de sécurité et de liquidité, momentum opposé. Frénésie est un
      profil témoin : il n’envoie aucune alerte, seuls ses portefeuilles virtuels tournent. Taux en grand à partir de
      {{ minSample }} signaux étiquetés.
    </p>
  `,
})
export class CalmFrenzyCard {
  readonly view = input.required<ComparisonView>();
  readonly segmentChange = output<PresetSegment>();

  protected readonly rows = computed(() => comparisonRows(this.view()));
  protected readonly minSample = MIN_SAMPLE_FOR_RATE;
}
