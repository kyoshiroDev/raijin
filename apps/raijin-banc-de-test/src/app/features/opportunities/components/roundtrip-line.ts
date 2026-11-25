import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { type TokenRow, DEFAULT_STAKE_SOL } from '@raijin/bench-web-logic';
import { roundtripCostView, type RoundtripTone } from '@raijin/bench-web-logic/opportunities';

export const ROUNDTRIP_TONE_TEXT: Record<RoundtripTone, string> = { bull: 'coût faible', warn: 'coût modéré', bear: 'coût élevé' };

/**
 * Card line: « Coût aller-retour : 0,0013 SOL (2,6 %) · +0,002 SOL de rent récupérable », the cost
 * coloured by net cost / stake. Nothing is ever cut: the cost part stays on one line and the rent
 * part wraps to the next line when the card is too narrow (full breakdown in the detail).
 */
@Component({
  selector: 'app-roundtrip-line',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    @let v = view();
    <p class="flex min-w-0 flex-wrap gap-x-1 slashed-zero" data-roundtrip>
      <span
        class="shrink-0 whitespace-nowrap"
        data-roundtrip-cost
        [class.text-bull]="v.tone === 'bull'"
        [class.text-warn]="v.tone === 'warn'"
        [class.text-bear]="v.tone === 'bear'"
        [class.text-muted]="v.tone === null"
        >{{ v.costText }}@if (v.tone; as tone) {<span class="sr-only"> ({{ toneText[tone] }})</span>}</span
      >
      <span class="min-w-0 text-muted" data-roundtrip-rent>{{ v.rentText }}</span>
    </p>
  `,
})
export class RoundtripLine {
  readonly token = input.required<TokenRow>();
  readonly stake = input(DEFAULT_STAKE_SOL);

  protected readonly toneText = ROUNDTRIP_TONE_TEXT;
  protected readonly view = computed(() => roundtripCostView(this.token(), this.stake()));
}
