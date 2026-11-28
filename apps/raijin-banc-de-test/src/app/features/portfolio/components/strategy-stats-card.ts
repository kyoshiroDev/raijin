import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { STRATEGY_LABEL, formatPercentFr, formatSignedSol, formatSolAmount } from '@raijin/bench-web-logic';
import { formatHits, formatRate } from '@raijin/bench-web-logic/performance';
import { type StrategyStats, pnlClass } from '@raijin/bench-web-logic/portfolio';

/**
 * KPIs of one strategy. Under 30 closed trades the TP/SL rates are replaced by « hits / n » in grey
 * with « échantillon insuffisant » (same rule as the Performance screen).
 */
@Component({
  selector: 'app-strategy-stats-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-2 p-3', '[attr.data-strategy-stats]': 'stats().strategy' },
  template: `
    @let s = stats();
    <h3 class="text-sm font-bold">{{ title() }} <span class="font-normal text-muted">· {{ s.trades }} trade{{ s.trades > 1 ? 's' : '' }}</span></h3>
    <p class="text-label text-muted" data-legs-note>Taux par jambe clôturée ({{ s.legs.closed }}){{ s.legs.breakeven > 0 ? ', dont ' + s.legs.breakeven + ' au breakeven' : '' }}.</p>
    <dl class="grid grid-cols-2 gap-x-3 gap-y-2 text-xs tabular-nums slashed-zero">
      @for (r of rates(); track r.key) {
        <div [attr.data-stat]="r.key">
          <dt class="text-muted">{{ r.label }}</dt>
          @if (s.enough) {
            <dd class="text-lg font-black" [class]="r.tone">{{ rate(r.rate) }}</dd>
            <dd class="text-label text-muted">{{ hits(r.hits, s.legs.closed) }}</dd>
          } @else {
            <dd class="text-sm text-muted" data-insufficient>{{ hits(r.hits, s.legs.closed) }}</dd>
            <dd class="text-label text-muted">échantillon insuffisant</dd>
          }
        </div>
      }
      <div data-stat="avg-win"><dt class="text-muted">Gain moyen</dt><dd class="font-bold" [class]="tone(s.avgWinSol)">{{ signed(s.avgWinSol) }}</dd></div>
      <div data-stat="avg-loss"><dt class="text-muted">Perte moyenne</dt><dd class="font-bold" [class]="tone(s.avgLossSol)">{{ signed(s.avgLossSol) }}</dd></div>
      <div data-stat="total"><dt class="text-muted">P&amp;L total</dt><dd class="font-bold" [class]="tone(s.totalPnlSol)">{{ signed(s.totalPnlSol) }}</dd></div>
      <div data-stat="streak">
        <dt class="text-muted">Pire série de pertes</dt>
        <dd class="font-bold">{{ s.worstStreak }}@if (s.worstStreak > 0) { <span class="font-normal text-bear"> · {{ signed(s.worstStreakSol) }}</span> }</dd>
      </div>
      <div class="col-span-2" data-stat="drawdown">
        <dt class="text-muted">Drawdown max (depuis un sommet)</dt>
        <dd class="font-bold" [class.text-bear]="s.drawdown.sol > 0">{{ drawdown() }}</dd>
      </div>
    </dl>
  `,
})
export class StrategyStatsCard {
  readonly stats = input.required<StrategyStats>();

  protected readonly title = computed(() => STRATEGY_LABEL[this.stats().strategy]);
  protected readonly rates = computed(() => {
    const s = this.stats();
    return [
      { key: 'tp', label: 'Taux de TP', rate: s.tpRate, hits: s.legs.tp, tone: 'text-bull' },
      { key: 'sl', label: 'Taux de SL', rate: s.slRate, hits: s.legs.sl, tone: 'text-bear' },
    ];
  });
  protected readonly drawdown = computed(() => {
    const d = this.stats().drawdown;
    return d.sol > 0 ? `−${formatSolAmount(d.sol)} SOL · −${formatPercentFr(d.pct)}` : 'aucun';
  });
  protected readonly rate = formatRate;
  protected readonly hits = formatHits;
  protected readonly signed = formatSignedSol;
  protected readonly tone = pnlClass;
}
