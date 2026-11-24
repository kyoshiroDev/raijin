import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ALERT_LIMITS } from '@raijin/bench-web-logic/settings';

export interface CapChange {
  field: 'max_per_hour' | 'max_per_day';
  /** NaN when empty / malformed (validation reports it, never sent). */
  value: number;
}

/** « Plafonds »: alerts per hour (1–20) and per day (1–100). */
@Component({
  selector: 'app-alert-caps-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', 'data-alert-caps': '' },
  template: `
    <fieldset class="space-y-2">
      <legend class="text-sm font-semibold">Plafonds</legend>
      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <label for="alert-max-per-hour" class="text-xs text-muted">Maximum par heure</label>
          <input
            id="alert-max-per-hour"
            type="number"
            inputmode="numeric"
            class="field tabular-nums slashed-zero"
            [min]="limits.max_per_hour.min"
            [max]="limits.max_per_hour.max"
            step="1"
            [value]="perHour()"
            [attr.aria-invalid]="!!perHourError()"
            (input)="onInput('max_per_hour', $event)"
          />
        </div>
        <div class="space-y-1">
          <label for="alert-max-per-day" class="text-xs text-muted">Maximum par jour</label>
          <input
            id="alert-max-per-day"
            type="number"
            inputmode="numeric"
            class="field tabular-nums slashed-zero"
            [min]="limits.max_per_day.min"
            [max]="limits.max_per_day.max"
            step="1"
            [value]="perDay()"
            [attr.aria-invalid]="!!perDayError()"
            (input)="onInput('max_per_day', $event)"
          />
        </div>
      </div>
      <p class="text-xs text-muted tabular-nums slashed-zero" data-caps-summary>
        Au plus {{ valid(perHour()) ? perHour() : '–' }} alertes / heure, {{ valid(perDay()) ? perDay() : '–' }} / jour.
      </p>
      @if (perHourError(); as e) { <p class="text-sm text-bear" role="alert">{{ e }}</p> }
      @if (perDayError(); as e) { <p class="text-sm text-bear" role="alert">{{ e }}</p> }
    </fieldset>
  `,
})
export class AlertCapsField {
  readonly perHour = input.required<number>();
  readonly perDay = input.required<number>();
  readonly perHourError = input<string | undefined>(undefined);
  readonly perDayError = input<string | undefined>(undefined);
  readonly capChange = output<CapChange>();

  protected readonly limits = ALERT_LIMITS;

  protected valid(n: number): boolean {
    return Number.isFinite(n);
  }

  protected onInput(field: CapChange['field'], event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const raw = event.target.value.trim();
    this.capChange.emit({ field, value: raw === '' ? Number.NaN : Number(raw) });
  }
}
