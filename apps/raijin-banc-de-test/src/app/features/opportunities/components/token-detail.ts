import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { TokenRow } from '../../../shared/models/token';
import { CopyAddress } from '../../../shared/ui/copy-address';
import { UpdatedAgo } from '../../../shared/ui/updated-ago';
import { formatUpdatedAgo } from '../../../shared/utils/format';
import { DEFAULT_STAKE_SOL } from '../../../shared/utils/stake';
import { PaperTradeLauncher } from '../../paper-trade/paper-trade-launcher';
import { liquidityLabel, liquiditySummary } from '../liquidity-sources';
import { marketStats, narrativeLabel, securityStats, tokenLinks } from '../token-display';
import { ConfidenceBadge } from './confidence-badge';
import { FlagList } from './flag-list';
import { LiquidityInfo } from './liquidity-info';
import { PriceChart } from './price-chart';
import { RoundtripBreakdown } from './roundtrip-breakdown';
import { RoundtripLine } from './roundtrip-line';
import { RugcheckSummary } from './rugcheck-summary';
import { StatGrid } from './stat-grid';
import { TokenAvatar } from './token-avatar';
import { TokenBadges } from './token-badges';
import { TokenLinkList } from './token-link-list';

let nextId = 0;

/** Full token detail (presentational). Used in the list's sheet/side panel and on /token/:mint. */
@Component({
  selector: 'app-token-detail',
  imports: [ConfidenceBadge, CopyAddress, FlagList, LiquidityInfo, PaperTradeLauncher, PriceChart, RoundtripBreakdown, RoundtripLine, RugcheckSummary, StatGrid, TokenAvatar, TokenBadges, TokenLinkList, UpdatedAgo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @let t = token();
    <div class="space-y-5">
      <div class="flex items-center gap-3">
        <app-token-avatar [imageUrl]="t.image_url" [symbol]="t.symbol" [mint]="t.mint" [size]="48" />
        <div class="min-w-0 flex-1">
          <p class="truncate font-bold">{{ t.symbol }}</p>
          <p class="truncate text-sm text-muted">{{ t.name }}</p>
          <app-confidence-badge [confidence]="t.data_confidence" />
        </div>
      </div>

      <section [attr.aria-labelledby]="uid + '-signals'" class="space-y-2" data-detail-signals>
        <h3 [id]="uid + '-signals'" class="text-xs font-semibold tracking-wide text-muted uppercase">Signaux</h3>
        <app-token-badges [token]="t" detailed />
        @if (narrative(); as n) {
          <p class="pill max-w-full bg-info/15 wrap-anywhere text-info" data-narrative>{{ n }}</p>
        }
        <app-roundtrip-line class="text-sm" [token]="t" [stake]="stake()" />
        <p class="text-label text-muted">Constats factuels, pas une recommandation d’achat.</p>
      </section>

      <app-price-chart [token]="t" />

      <app-paper-trade-launcher [mint]="t.mint" [symbol]="t.symbol" [currentPrice]="t.price_usd" [stake]="stake()" />

      <section [attr.aria-labelledby]="uid + '-market'" class="space-y-3">
        <h3 [id]="uid + '-market'" class="text-xs font-semibold tracking-wide text-muted uppercase">Marché</h3>
        <div class="text-sm tabular-nums slashed-zero">
          <p class="text-xs text-muted">{{ liqLabel() }}</p>
          <app-liquidity-info [token]="t" [inline]="true" />
        </div>
        <app-stat-grid [stats]="market()" />
        <app-roundtrip-breakdown class="text-sm" [token]="t" [stake]="stake()" [eurPerSol]="eurPerSol()" />
      </section>

      <section [attr.aria-labelledby]="uid + '-security'" class="space-y-3">
        <h3 [id]="uid + '-security'" class="text-xs font-semibold tracking-wide text-muted uppercase">Sécurité</h3>
        <app-stat-grid [stats]="security()" />
        <app-flag-list [flags]="t.flags" emptyText="Aucun point d’attention relevé." />
        <app-rugcheck-summary [token]="t" />
      </section>

      <section [attr.aria-labelledby]="uid + '-address'" class="space-y-2">
        <h3 [id]="uid + '-address'" class="text-xs font-semibold tracking-wide text-muted uppercase">Adresse du token</h3>
        <app-copy-address [address]="t.mint" [label]="t.symbol" />
      </section>

      <section [attr.aria-labelledby]="uid + '-links'" class="space-y-2">
        <h3 [id]="uid + '-links'" class="text-xs font-semibold tracking-wide text-muted uppercase">Liens</h3>
        <app-token-link-list [links]="links()" />
      </section>

      <div class="space-y-1 border-t border-line pt-3 text-label text-muted">
        <app-updated-ago [at]="t.updated_at" />
        <p data-enriched>{{ enriched() }}</p>
        <p>Aide à la décision, pas un conseil en investissement. Ne mise que ce que tu acceptes de perdre.</p>
      </div>
    </div>
  `,
})
export class TokenDetail {
  readonly token = input.required<TokenRow>();
  /** User's usual stake in SOL (round-trip estimate). */
  readonly stake = input(DEFAULT_STAKE_SOL);
  /** € per SOL from the latest scan run (MarketContext); null → amounts in SOL only. */
  readonly eurPerSol = input<number | null>(null);

  protected readonly uid = `token-detail-${++nextId}`;

  protected readonly narrative = computed(() => narrativeLabel(this.token()));
  protected readonly market = computed(() => marketStats(this.token()));
  protected readonly security = computed(() => securityStats(this.token()));
  protected readonly links = computed(() => tokenLinks(this.token()));
  protected readonly liqLabel = computed(() => liquidityLabel(liquiditySummary(this.token())));
  protected readonly enriched = computed(() => {
    const at = this.token().enriched_at;
    return at ? formatUpdatedAgo(at, Date.now(), 'Enrichi') : 'Pas encore enrichi (sources croisées)';
  });
}
