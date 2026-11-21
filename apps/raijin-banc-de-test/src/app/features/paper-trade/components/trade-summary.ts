import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { formatPrice, formatSignedPercentFr, formatSignedSol, formatSolAmount } from '../../../shared/utils/format';
import type { TradeSummary } from '../paper-strategy';

/** Summary shown before validation: target, stop, fees, rent and the result of both scenarios (presentational). */
@Component({
  selector: 'app-trade-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', 'data-trade-summary': '' },
  template: `
    @if (summary(); as s) {
      <div class="space-y-3 rounded-xl bg-surface-2 p-3 text-sm tabular-nums slashed-zero">
        <dl class="space-y-1">
          <div class="flex justify-between gap-3" data-sum="tp-all">
            <dt class="text-muted">Objectif (100 %) · ×2</dt>
            <dd class="text-bull">{{ price(s.plan.tpPrice) }}</dd>
          </div>
          <div class="flex justify-between gap-3" data-sum="sl">
            <dt class="text-muted">Stop</dt>
            <dd class="text-bear">{{ price(s.plan.slPrice) }}</dd>
          </div>
        </dl>
        <dl class="space-y-1 border-t border-line pt-2">
          <div class="flex justify-between gap-3" data-sum="fees">
            <dt class="text-muted">Frais réseau estimés ({{ s.txCount }} transactions)</dt>
            <dd>{{ sol(s.networkFeesSol) }} SOL</dd>
          </div>
          <div class="flex justify-between gap-3" data-sum="rent">
            <dt class="text-muted">Rent (bloqué, rendu à la clôture)</dt>
            <dd>{{ sol(s.rentSol) }} SOL</dd>
          </div>
          <div class="flex justify-between gap-3" data-sum="required">
            <dt class="text-muted">Total mobilisé à l’entrée</dt>
            <dd>{{ sol(s.requiredSol) }} SOL</dd>
          </div>
        </dl>
        <dl class="space-y-1 border-t border-line pt-2">
          @for (sc of s.scenarios; track sc.key) {
            <div class="flex justify-between gap-3" [attr.data-scenario]="sc.key">
              <dt class="text-muted">{{ sc.label }}</dt>
              <dd class="shrink-0 font-semibold" [class.text-bull]="sc.pnlSol > 0" [class.text-bear]="sc.pnlSol < 0">
                {{ signed(sc.pnlSol) }} · {{ pct(sc.pnlPct) }}
              </dd>
            </div>
          }
        </dl>
      </div>
      <p class="mt-1 text-label text-muted">
        Objectif et stop recalculés sur le prix d’achat réel une fois l’entrée exécutée. Slippage simulé de
        {{ slippageLabel() }} à l’achat et à la vente, frais compris. Estimation, pas une promesse.
      </p>
    } @else {
      <p class="rounded-xl bg-surface-2 p-3 text-sm text-muted">Corrige les champs pour voir le résumé.</p>
    }
  `,
})
export class TradeSummaryView {
  readonly summary = input<TradeSummary | null>(null);
  /** Slippage fraction shown in the note. */
  readonly slippage = input(0.02);

  protected readonly slippageLabel = computed(() => `${String(Math.round(this.slippage() * 1000) / 10).replace('.', ',')} %`);
  protected readonly sol = formatSolAmount;
  protected readonly price = formatPrice;
  protected readonly signed = formatSignedSol;
  protected readonly pct = formatSignedPercentFr;
}
