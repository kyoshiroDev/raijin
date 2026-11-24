import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { type TokenRow, formatPercentFr, formatSolAmount, formatSolEur, formatUpdatedAgo, NETWORK_FEE_PER_TX_SOL, ROUNDTRIP_TX_COUNT, DEFAULT_STAKE_SOL, formatSol } from '@raijin/bench-web-logic';
import { roundtripCostView, buyImpactLabel } from '@raijin/bench-web-logic/opportunities';
import { ROUNDTRIP_TONE_TEXT } from './roundtrip-line';

const UNKNOWN = 'inconnu';

/**
 * Detail: round-trip cost in SOL for the user's stake (slippage + pool fees, network fees,
 * recoverable rent, totals, break-even), the buy impact of the 0.1 SOL quote and the estimation note.
 * € equivalents only when a rate from the latest scan run is known.
 */
@Component({
  selector: 'app-roundtrip-breakdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @let v = view();
    <div class="space-y-2" data-roundtrip-breakdown>
      <p class="font-semibold">Coût aller-retour pour {{ stakeLabel() }} SOL{{ v.estimated ? ' (estimé)' : '' }}</p>
      <dl class="space-y-1.5 text-xs tabular-nums slashed-zero">
        <div class="flex items-baseline justify-between gap-3" data-cost-slippage>
          <dt class="text-muted">Slippage et frais de pool</dt>
          <dd class="text-right">{{ amount(v.cost.slippageAndPoolFeesSol) }}</dd>
        </div>
        <div class="flex items-baseline justify-between gap-3" data-cost-network>
          <dt class="text-muted">Frais réseau ({{ txCount }} × {{ perTx }} SOL)</dt>
          <dd class="text-right">{{ amount(v.cost.networkFeesSol) }}</dd>
        </div>
        <div class="flex flex-wrap items-baseline justify-between gap-x-3" data-cost-rent>
          <dt class="text-muted">Rent du compte token</dt>
          <dd class="text-right">{{ amount(v.cost.rentSol) }}</dd>
          <dd class="mt-0.5 basis-full text-label text-muted">
            Récupérable en fermant le compte du token après la vente (Phantom / Solflare : Burn / Close token account).
          </dd>
        </div>
        <div class="flex items-baseline justify-between gap-3 border-t border-line pt-1.5" data-cost-paid>
          <dt class="text-muted">Total payé</dt>
          <dd class="text-right">{{ amount(v.cost.totalPaidSol) }}</dd>
        </div>
        <div class="flex items-baseline justify-between gap-3 font-semibold" data-cost-net>
          <dt>Total net (après récupération du rent)</dt>
          <dd
            class="text-right"
            [class.text-bull]="v.tone === 'bull'"
            [class.text-warn]="v.tone === 'warn'"
            [class.text-bear]="v.tone === 'bear'"
            [class.text-muted]="v.tone === null"
          >
            {{ amount(v.cost.totalNetSol) }}@if (v.tone; as tone) {<span class="sr-only"> ({{ toneText[tone] }})</span>}
          </dd>
        </div>
      </dl>
      <p class="text-xs" data-break-even>
        @if (v.netPct !== null) {
          Le token doit monter d’au moins <b class="tabular-nums slashed-zero">{{ pct(v.netPct) }}</b> pour rentrer dans tes frais.
        } @else {
          <span class="text-muted">Seuil de rentabilité inconnu : pas encore de devis Jupiter.</span>
        }
      </p>
      <div class="space-y-1 text-xs text-muted">
        <p>Impact de prix à l’achat (0,1 SOL) : <span class="text-fg tabular-nums slashed-zero">{{ impact() }}</span></p>
        @if (v.netPct !== null) {
          @if (v.estimated) {
            <p>Estimation à partir d’un devis Jupiter de 0,1 SOL ; l’impact de prix croît avec la mise.</p>
          } @else {
            <p>Devis Jupiter pour 0,1 SOL (achat puis revente immédiate).</p>
          }
          @if (quoteAge(); as age) { <p>{{ age }}</p> }
        }
      </div>
    </div>
  `,
})
export class RoundtripBreakdown {
  readonly token = input.required<TokenRow>();
  readonly stake = input(DEFAULT_STAKE_SOL);
  /** € per SOL from the latest scan run; null → no € shown. */
  readonly eurPerSol = input<number | null>(null);

  protected readonly toneText = ROUNDTRIP_TONE_TEXT;
  protected readonly txCount = ROUNDTRIP_TX_COUNT;
  protected readonly perTx = formatSolAmount(NETWORK_FEE_PER_TX_SOL);
  protected readonly pct = formatPercentFr;

  protected readonly view = computed(() => roundtripCostView(this.token(), this.stake()));
  protected readonly stakeLabel = computed(() => formatSol(this.view().cost.stakeSol));
  protected readonly impact = computed(() => buyImpactLabel(this.token()));
  protected readonly quoteAge = computed(() => {
    const at = this.token().quote_at;
    return at ? formatUpdatedAgo(at, Date.now(), 'Devis') : null;
  });

  protected amount(sol: number | null): string {
    return sol === null ? UNKNOWN : formatSolEur(sol, this.eurPerSol());
  }
}
