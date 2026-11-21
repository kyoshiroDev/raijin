import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { simulationDetail, simulationHeadline, type AlertSimulation } from '../alert-simulation';

/** 7-day summary and simulated result (presentational). The sign of the result is written (+/−). */
@Component({
  selector: 'app-alerts-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section class="card space-y-2" aria-labelledby="alerts-summary-title">
      <h2 id="alerts-summary-title" class="sr-only">Bilan des 7 derniers jours</h2>
      <p class="text-sm font-semibold tabular-nums slashed-zero" data-summary-headline>
        {{ headline() }}
      </p>
      <p class="text-xs text-muted tabular-nums slashed-zero" data-summary-detail>{{ detail() }}</p>
      @if (truncated()) {
        <p class="text-label text-warn">Beaucoup d’alertes : seules les plus récentes sont comptées.</p>
      }
      <p class="text-label text-muted">Simulation, pas un conseil en investissement ; les prix sont échantillonnés toutes les 2 min.</p>
    </section>
  `,
})
export class AlertsSummary {
  readonly summary = input.required<AlertSimulation>();
  /** The fetch hit its limit: older alerts of the window may be missing. */
  readonly truncated = input(false);

  protected readonly headline = computed(() => simulationHeadline(this.summary()));
  protected readonly detail = computed(() => simulationDetail(this.summary()));
}
