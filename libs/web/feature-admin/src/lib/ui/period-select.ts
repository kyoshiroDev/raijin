import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { type AdminPeriod, type ResolvedRange } from '@raijin/shared-contracts';
import { RjIcon } from '@raijin/web-ui';
import { AdminIcons } from './admin-icons';
import { formatRange } from './format';

let nextId = 0;

/** Libellés courts des périodes (le contrat garde les libellés longs pour les phrases). */
export const PERIOD_SHORT_LABELS: Readonly<Record<AdminPeriod, string>> = {
  today: 'Auj.',
  '7d': '7 j',
  '30d': '30 j',
  '90d': '90 j',
};

const PERIOD_SPOKEN: Readonly<Record<AdminPeriod, string>> = {
  today: 'Aujourd’hui',
  '7d': '7 derniers jours',
  '30d': '30 derniers jours',
  '90d': '90 derniers jours',
};

/**
 * Sélecteur de période (boutons radio segmentés, clavier natif) : 7 / 30 / 90 jours par défaut.
 * Tient à 320 px. `[periods]` choisit les options (ex. `['today', '7d', '30d', '90d']`).
 *
 * `<rj-period-select [(period)]="period" />` ; la période résolue par l'API s'affiche avec `rj-range-caption`.
 */
@Component({
  selector: 'rj-period-select',
  template: `
    <fieldset class="min-w-0">
      <legend class="sr-only">{{ legend() }}</legend>
      <div class="inline-flex rounded-md border border-line bg-surface p-1">
        @for (option of periods(); track option) {
          <label
            class="relative inline-flex min-h-11 min-w-12 cursor-pointer items-center justify-center rounded-sm px-3 text-body-sm font-semibold transition-colors hover:text-ink duration-150 ease-raijin has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus-ring"
            [class.bg-surface-raised]="option === period()"
            [class.text-ink]="option === period()"
            [class.text-ink-muted]="option !== period()"
          >
            <input
              type="radio"
              class="peer absolute inset-0 cursor-pointer opacity-0"
              [name]="name"
              [value]="option"
              [checked]="option === period()"
              (change)="period.set(option)"
            />
            <span aria-hidden="true">{{ short[option] }}</span>
            <span class="sr-only">{{ spoken[option] }}</span>
          </label>
        }
      </div>
    </fieldset>
  `,
  host: { class: 'inline-block min-w-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjPeriodSelect {
  readonly period = model<AdminPeriod>('7d');
  readonly periods = input<readonly AdminPeriod[]>(['7d', '30d', '90d']);
  readonly legend = input('Période');

  protected readonly name = `rj-period-${nextId++}`;
  protected readonly short = PERIOD_SHORT_LABELS;
  protected readonly spoken = PERIOD_SPOKEN;
}

/**
 * Rappel de la période affichée et de la comparaison : « Du 16 au 22 nov. · comparé au 9 au 15 nov. (UTC) ».
 * `<rj-range-caption [range]="report.range" />`
 */
@Component({
  selector: 'rj-range-caption',
  imports: [RjIcon],
  template: `
    @if (text(); as text) {
      <rj-icon [name]="icon" [size]="16" class="mt-0.5" />
      <span>{{ text }}</span>
    }
  `,
  host: { class: 'flex items-start gap-1.5 text-body-sm text-ink-muted' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjRangeCaption {
  readonly range = input<ResolvedRange | null>(null);
  protected readonly icon = AdminIcons.period;
  protected readonly text = computed(() => {
    const range = this.range();
    if (!range) return '';
    const current = formatRange(range.current.from, range.current.to);
    const { from, to } = range.previous;
    const previous = from === to ? `au ${formatRange(from, to)}` : `à la période ${formatRange(from, to)}`;
    return `${current.charAt(0).toUpperCase()}${current.slice(1)}, comparé ${previous} (jours UTC)`;
  });
}
