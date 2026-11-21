import { ChangeDetectionStrategy, Component, input, linkedSignal, output } from '@angular/core';
import { STAKE_LIMITS, formatSol, parseStakeInput } from '../../../shared/utils/stake';

/**
 * « Ma mise habituelle (SOL) ». Text input with the decimal keypad so the French comma works
 * everywhere (a type="number" field drops « 0,25 » in some browsers); emits the parsed number
 * (NaN when malformed — validation reports it, it is never sent).
 */
@Component({
  selector: 'app-stake-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block space-y-1' },
  template: `
    <label for="alert-stake-sol" class="text-sm font-semibold">Ma mise habituelle (SOL)</label>
    <input
      id="alert-stake-sol"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      class="field tabular-nums slashed-zero"
      [attr.min]="limits.min"
      [attr.max]="limits.max"
      [attr.step]="limits.step"
      [value]="text()"
      [attr.aria-invalid]="!!error()"
      aria-describedby="alert-stake-sol-hint"
      (input)="onInput($event)"
    />
    <p id="alert-stake-sol-hint" class="text-xs text-muted">
      Entre 0,01 et 100 SOL. Sert à estimer le coût aller-retour affiché sur chaque opportunité.
    </p>
    @if (error(); as e) { <p class="text-sm text-bear" role="alert">{{ e }}</p> }
  `,
})
export class StakeField {
  readonly stake = input.required<number>();
  readonly error = input<string | undefined>(undefined);
  readonly stakeChange = output<number>();

  protected readonly limits = STAKE_LIMITS;
  /** Raw text, reset (French formatting) whenever the stored stake changes. */
  protected readonly text = linkedSignal(() => (Number.isFinite(this.stake()) ? formatSol(this.stake()) : ''));

  protected onInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.text.set(target.value);
    this.stakeChange.emit(parseStakeInput(target.value));
  }
}
