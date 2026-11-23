import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { VERDICT_LABELS, type Verdict } from '@raijin/shared-contracts';
import type { AccuracyReport, MetricDelta, Period, ReplayReport, VariantReplay } from '@raijin/bench-verdicts';
import { formatDeltaPoints, formatPeriod } from '../verdict-quality-format';
import { ProportionValue } from './proportion-value';

type ComparedMetric = keyof MetricDelta;

export const COMPARED_METRICS: readonly { key: ComparedMetric; label: string }[] = [
  { key: 'dangerPrecision', label: 'Précision du Danger' },
  { key: 'dangerRecall', label: 'Rappel du Danger' },
  { key: 'falseSafeRate', label: 'Faux « Sain »' },
  { key: 'cautionPositiveRate', label: 'Rugs parmi les Prudence' },
];

const VERDICTS: readonly Verdict[] = ['safe', 'warn', 'danger'];

/**
 * Moteur actuel vs variante choisie, rejoués sur les mêmes faits et les mêmes issues (période de
 * validation). L'écart n'est affiché que si les deux côtés ont un échantillon suffisant.
 */
@Component({
  selector: 'app-variant-comparison',
  imports: [ProportionValue],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block space-y-3' },
  template: `
    @let r = replay();
    @if (r.variants.length === 0) {
      <p class="card text-sm text-muted" data-no-variant>Aucune variante enregistrée.</p>
    } @else {
      @let v = selected();
      <div class="space-y-1">
        <label for="variant-select" class="text-xs font-semibold text-muted">Variante comparée</label>
        <select id="variant-select" class="field" data-variant-select (change)="choose($event)">
          @for (item of r.variants; track item.id) {
            <option [value]="item.id" [selected]="item.id === v.id">{{ item.label }}</option>
          }
        </select>
      </div>
      <p class="text-xs text-muted" data-replay-meta>
        Période de validation : {{ period(validationPeriod()) }} · {{ r.replayed }} verdicts rejoués
        @if (r.skippedFactsVersion > 0) {
          · {{ r.skippedFactsVersion }} écartés (faits d’une autre version)
        }
        · moteur actuel {{ r.reference.version }} ({{ r.reference.fingerprint }}) · variante {{ v.version }} ({{ v.fingerprint }})
      </p>

      <ul class="space-y-2 md:hidden" aria-label="Comparaison des métriques">
        @for (m of metrics; track m.key) {
          <li class="card space-y-2" [attr.data-compare-card]="m.key">
            <p class="text-sm font-semibold">{{ m.label }}</p>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <p class="text-label text-muted">Moteur actuel</p>
                <app-proportion-value [p]="r.reference.accuracy[m.key]" [minSample]="minSample()" [compact]="true" />
              </div>
              <div>
                <p class="text-label text-muted">Variante</p>
                <app-proportion-value [p]="v.accuracy[m.key]" [minSample]="minSample()" [compact]="true" />
              </div>
            </div>
            <p class="text-xs" data-delta>Écart : {{ deltaText(r.reference.accuracy, v, m.key) }}</p>
          </li>
        }
      </ul>
      <div class="hidden overflow-x-auto md:block">
        <table class="w-full text-left text-sm" data-compare-table>
          <caption class="sr-only">Moteur actuel et variante, métriques de justesse</caption>
          <thead class="text-xs text-muted">
            <tr>
              <th scope="col" class="py-2 pr-3 font-semibold">Métrique</th>
              <th scope="col" class="py-2 pr-3 font-semibold">Moteur actuel</th>
              <th scope="col" class="py-2 pr-3 font-semibold">Variante</th>
              <th scope="col" class="py-2 font-semibold">Écart</th>
            </tr>
          </thead>
          <tbody>
            @for (m of metrics; track m.key) {
              <tr class="border-t border-line align-top" [attr.data-compare-row]="m.key">
                <th scope="row" class="py-2 pr-3 font-semibold">{{ m.label }}</th>
                <td class="py-2 pr-3"><app-proportion-value [p]="r.reference.accuracy[m.key]" [minSample]="minSample()" [compact]="true" /></td>
                <td class="py-2 pr-3"><app-proportion-value [p]="v.accuracy[m.key]" [minSample]="minSample()" [compact]="true" /></td>
                <td class="py-2 tabular-nums" data-delta>{{ deltaText(r.reference.accuracy, v, m.key) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="card space-y-3" data-changes>
        <h3 class="text-sm font-semibold">Verdicts changés par la variante</h3>
        <dl class="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div><dt class="text-label text-muted">Changés</dt><dd class="font-bold tabular-nums" data-changed>{{ v.changes.changed }}</dd></div>
          <div><dt class="text-label text-muted">Corrigés</dt><dd class="font-bold tabular-nums text-bull" data-improved>{{ v.changes.improved }}</dd></div>
          <div><dt class="text-label text-muted">Dégradés</dt><dd class="font-bold tabular-nums text-bear" data-degraded>{{ v.changes.degraded }}</dd></div>
          <div><dt class="text-label text-muted">Non jugés (issue inconnue)</dt><dd class="font-bold tabular-nums">{{ v.changes.unscored }}</dd></div>
        </dl>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm" data-change-matrix>
            <caption class="pb-2 text-left text-xs text-muted">Moteur actuel (lignes) → variante (colonnes)</caption>
            <thead class="text-xs text-muted">
              <tr>
                <th scope="col" class="py-1 pr-2 font-semibold">Actuel ↓ · variante →</th>
                @for (to of verdicts; track to) {
                  <th scope="col" class="py-1 pr-2 font-semibold">{{ verdictLabel[to] }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (from of verdicts; track from) {
                <tr class="border-t border-line">
                  <th scope="row" class="py-1 pr-2 font-semibold">{{ verdictLabel[from] }}</th>
                  @for (to of verdicts; track to) {
                    <td class="py-1 pr-2 tabular-nums" [class.text-muted]="from === to">{{ v.changes.matrix[from][to] }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    }
  `,
})
export class VariantComparison {
  readonly replay = input.required<ReplayReport>();
  readonly validationPeriod = input<Period | null>(null);
  readonly minSample = input(30);

  protected readonly metrics = COMPARED_METRICS;
  protected readonly verdicts = VERDICTS;
  protected readonly verdictLabel = VERDICT_LABELS;
  protected readonly period = formatPeriod;
  private readonly chosen = signal<string | null>(null);

  protected readonly selected = computed<VariantReplay>(() => {
    const variants = this.replay().variants;
    return variants.find((item) => item.id === this.chosen()) ?? (variants[0] as VariantReplay);
  });

  protected choose(event: Event): void {
    this.chosen.set((event.target as HTMLSelectElement).value);
  }

  /** Écart en points, ou « échantillon insuffisant » si un des deux côtés l'est. */
  protected deltaText(reference: AccuracyReport, variant: VariantReplay, key: ComparedMetric): string {
    if (reference[key].insufficient || variant.accuracy[key].insufficient) return 'échantillon insuffisant';
    return formatDeltaPoints(variant.delta[key]);
  }
}
