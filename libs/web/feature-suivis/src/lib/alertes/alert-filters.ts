import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ALERT_READ_FILTER_LABELS, ALERT_TYPES, ALERT_TYPE_LABELS, type AlertReadFilter, type AlertType } from '@raijin/shared-contracts';
import type { AlertFilters } from '@raijin/web-data-access';
import { RjCheckbox } from '@raijin/web-ui';

export interface TokenOption {
  readonly mint: string;
  readonly label: string;
}

let nextId = 0;

/**
 * Filtres de l'historique : lu / non lu (boutons radio), types (cases à cocher), token (liste).
 * Partagés par la bottom sheet (mobile) et le panneau latéral (desktop) ; chaque changement est
 * appliqué tout de suite.
 */
@Component({
  selector: 'rj-alert-filters',
  imports: [RjCheckbox],
  template: `
    <fieldset class="flex flex-col gap-2">
      <legend class="mb-2 text-body-sm font-semibold text-ink">État</legend>
      <div class="grid grid-cols-3 gap-1 rounded-md border border-line bg-base p-1">
        @for (status of statuses; track status) {
          <label
            [class]="
              'relative flex min-h-11 cursor-pointer items-center justify-center rounded-sm px-2 text-body-sm font-medium transition-colors duration-150 ease-raijin has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus-ring ' +
              (filters().status === status ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:text-ink')
            "
          >
            <input
              type="radio"
              class="sr-only"
              [name]="radioName"
              [value]="status"
              [checked]="filters().status === status"
              (change)="setStatus(status)"
            />
            {{ statusLabels[status] }}
          </label>
        }
      </div>
    </fieldset>

    <fieldset class="flex flex-col">
      <legend class="mb-1 text-body-sm font-semibold text-ink">Type d’alerte</legend>
      @for (type of types; track type) {
        <rj-checkbox [checked]="filters().types.includes(type)" (checkedChange)="toggleType(type, $event)">{{ typeLabels[type] }}</rj-checkbox>
      }
    </fieldset>

    <div class="flex flex-col gap-2">
      <label [for]="selectId" class="text-body-sm font-semibold text-ink">Token</label>
      <select
        [id]="selectId"
        class="min-h-11 w-full rounded-md border border-line-strong bg-surface-raised px-3 text-input text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        (change)="setMint($any($event.target).value)"
      >
        <option value="" [selected]="!filters().mint">Tous les tokens</option>
        @for (token of tokens(); track token.mint) {
          <option [value]="token.mint" [selected]="filters().mint === token.mint">{{ token.label }}</option>
        }
      </select>
    </div>
  `,
  host: { class: 'flex flex-col gap-6' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAlertFilters {
  readonly filters = input.required<AlertFilters>();
  readonly tokens = input<readonly TokenOption[]>([]);
  readonly filtersChange = output<AlertFilters>();

  protected readonly statuses: readonly AlertReadFilter[] = ['all', 'unread', 'read'];
  protected readonly statusLabels = ALERT_READ_FILTER_LABELS;
  protected readonly types = ALERT_TYPES;
  protected readonly typeLabels = ALERT_TYPE_LABELS;
  private readonly id = nextId++;
  protected readonly radioName = `rj-alert-status-${this.id}`;
  protected readonly selectId = `rj-alert-token-${this.id}`;

  protected setStatus(status: AlertReadFilter): void {
    this.filtersChange.emit({ ...this.filters(), status });
  }

  protected toggleType(type: AlertType, checked: boolean): void {
    const current = this.filters().types.filter((item) => item !== type);
    // Ordre stable (celui du contrat) : même URL pour la même sélection.
    const next = checked ? ALERT_TYPES.filter((item) => item === type || current.includes(item)) : current;
    this.filtersChange.emit({ ...this.filters(), types: next });
  }

  protected setMint(mint: string): void {
    this.filtersChange.emit({ ...this.filters(), mint: mint || null });
  }
}
