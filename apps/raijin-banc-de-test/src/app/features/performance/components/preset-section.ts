import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MIN_SAMPLE_FOR_RATE, type ComparisonView, type PresetSegment } from '@raijin/bench-web-logic/performance';
import type { PresetState } from '../performance-store';
import { CalmFrenzyCard } from './calm-frenzy-card';

/** « Par profil d’alertes »: the « Calme vs Frénésie » card, with its own loading / not-deployed / error states. */
@Component({
  selector: 'app-preset-section',
  imports: [CalmFrenzyCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block space-y-2', 'data-preset-section': '' },
  template: `
    <h2 id="perf-presets" class="text-xs font-semibold tracking-wide text-muted uppercase">Par profil d’alertes</h2>
    @switch (state()) {
      @case ('ready') {
        @if (comparison(); as cmp) {
          <app-calm-frenzy-card [view]="cmp" (segmentChange)="comparisonSegmentChange.emit($event)" />
        }
        <p class="text-xs text-muted">Stop = −30 % sous l’entrée. Taux en grand à partir de {{ minSample }} signaux étiquetés.</p>
      }
      @case ('unavailable') {
        <p class="card text-sm text-muted" role="status" data-presets-unavailable>Résultats par profil pas encore disponibles côté serveur.</p>
      }
      @case ('error') {
        <div class="card space-y-3 text-center" role="alert" data-presets-error>
          <p class="text-sm text-bear">{{ errorText() }}</p>
          <button type="button" class="btn-ghost w-full" (click)="retry.emit()">Réessayer</button>
        </div>
      }
      @default {
        <p class="py-4 text-center text-sm text-muted" role="status">Chargement des profils…</p>
      }
    }
  `,
})
export class PresetSection {
  readonly state = input.required<PresetState>();
  readonly errorText = input('');
  /** « Calme vs Frénésie » card; null = hidden. */
  readonly comparison = input<ComparisonView | null>(null);
  readonly comparisonSegmentChange = output<PresetSegment>();
  readonly retry = output();

  protected readonly minSample = MIN_SAMPLE_FOR_RATE;
}
