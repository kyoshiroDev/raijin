import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  ADMIN_KPI_LABELS,
  NOT_CONNECTED_LABEL,
  type AdminKpi,
  type MetricSource,
  type MetricStatus,
  type MetricUnit,
} from '@raijin/shared-contracts';
import { RjIcon } from '@raijin/web-ui';
import { AdminIcons } from './admin-icons';
import { NO_VALUE, changeDirection, changeTone, describeChange, formatChange, formatMetric } from './format';

const TONE_CLASSES = {
  good: 'text-safe',
  bad: 'text-danger',
  neutral: 'text-ink-muted',
} as const;

/**
 * Carte KPI : libellé, chiffre en mono tabulaire, variation par rapport à la période précédente.
 * La variation se lit sans la couleur : flèche (hausse / baisse / stable) + signe + pourcentage, et une phrase
 * complète pour les lecteurs d'écran. `higherIsBetter = false` (churn) inverse la couleur, jamais l'icône.
 *
 * Usage : `<rj-kpi-card [kpi]="kpi" />` (contrat `AdminKpi`) ou champ par champ :
 * `<rj-kpi-card label="MRR" unit="cents" [value]="1234500" [change]="0.12" />`.
 * Hauteur égale dans une grille (`rj-kpi-grid`) : libellé sur 2 lignes réservées.
 * Le chiffre n'est jamais tronqué : une valeur longue (« 1 min 22 s », « 12,3 k€ ») passe sur deux lignes, coupée
 * entre ses groupes (espaces insécables entre nombre et unité, voir `formatDuration`).
 */
@Component({
  selector: 'rj-kpi-card',
  imports: [RjIcon],
  template: `
    <p class="line-clamp-2 min-h-10 text-body-sm text-ink-muted" [attr.title]="resolvedLabel()">{{ resolvedLabel() }}</p>
    @if (resolvedStatus() === 'ok') {
      <p class="tabular text-h3 font-semibold text-balance wrap-break-word text-ink xs:text-h2 md:text-metric" data-kpi-value>{{ formatted() }}</p>
      <p class="mt-auto flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-label">
        @if (variation(); as v) {
          <span [class]="'inline-flex items-center gap-1 font-semibold ' + v.toneClass">
            <rj-icon [name]="v.icon" [size]="16" />
            <span class="tabular" aria-hidden="true">{{ v.text }}</span>
            <span class="sr-only">{{ v.spoken }}</span>
          </span>
          <span class="text-ink-muted" aria-hidden="true">{{ comparisonLabel() }}</span>
        } @else if (isNew()) {
          <span class="inline-flex items-center gap-1 font-semibold text-ink">
            <rj-icon [name]="icons.up" [size]="16" />Nouveau
          </span>
          <span class="text-ink-muted">{{ comparisonLabel() }}</span>
        } @else {
          <span class="text-ink-muted">Pas de comparaison</span>
        }
      </p>
    } @else {
      <p class="tabular text-h3 font-semibold text-ink-muted xs:text-h2 md:text-metric" aria-hidden="true">{{ noValue }}</p>
      <p class="mt-auto inline-flex min-h-5 items-center gap-1.5 text-label font-semibold text-ink-muted">
        <rj-icon [name]="resolvedStatus() === 'not_connected' ? icons.notConnected : 'unavailable'" [size]="16" />
        {{ resolvedStatus() === 'not_connected' ? notConnected : 'Indisponible' }}
      </p>
    }
  `,
  host: {
    role: 'group',
    '[attr.aria-label]': 'resolvedLabel()',
    class: 'flex h-full min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-surface p-4 md:gap-2 md:p-5',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjKpiCard {
  /** KPI de la vue d'ensemble : remplit tous les champs (libellé depuis `ADMIN_KPI_LABELS`). */
  readonly kpi = input<AdminKpi | null>(null);
  readonly label = input('');
  readonly value = input<number | null>(null);
  readonly unit = input<MetricUnit>('count');
  /** Variation relative (0,12 = +12 %), `null` si non définie. */
  readonly change = input<number | null>(null);
  /** Valeur de la période précédente : à 0 avec une valeur courante, la carte affiche « Nouveau ». */
  readonly previous = input<number | null>(null);
  readonly higherIsBetter = input(true);
  readonly status = input<MetricStatus>('ok');
  readonly source = input<MetricSource>('internal');
  readonly currency = input('EUR');
  /** Texte après la variation : « vs 7 j préc. ». */
  readonly comparisonLabel = input('vs période préc.');

  protected readonly icons = AdminIcons;
  protected readonly noValue = NO_VALUE;
  protected readonly notConnected = NOT_CONNECTED_LABEL;

  protected readonly resolvedLabel = computed(() => {
    const kpi = this.kpi();
    return kpi ? ADMIN_KPI_LABELS[kpi.key] : this.label();
  });
  protected readonly resolvedStatus = computed(() => this.kpi()?.status ?? this.status());
  private readonly resolvedValue = computed(() => {
    const kpi = this.kpi();
    return kpi ? kpi.value : this.value();
  });
  private readonly resolvedChange = computed(() => {
    const kpi = this.kpi();
    return kpi ? kpi.change : this.change();
  });

  protected readonly formatted = computed(() => {
    const kpi = this.kpi();
    return formatMetric(this.resolvedValue(), kpi?.unit ?? this.unit(), { currency: this.currency(), compact: true });
  });

  protected readonly variation = computed(() => {
    const change = this.resolvedChange();
    if (change === null || !Number.isFinite(change)) return null;
    const higherIsBetter = this.kpi()?.higherIsBetter ?? this.higherIsBetter();
    const direction = changeDirection(change);
    return {
      text: formatChange(change),
      spoken: `${describeChange(change)} par rapport à la période précédente`,
      icon: direction === 'up' ? AdminIcons.up : direction === 'down' ? AdminIcons.down : AdminIcons.flat,
      toneClass: TONE_CLASSES[changeTone(change, higherIsBetter)],
    };
  });

  protected readonly isNew = computed(() => {
    const kpi = this.kpi();
    const previous = kpi ? kpi.previous : this.previous();
    const value = this.resolvedValue();
    return previous === 0 && value !== null && value > 0;
  });
}
