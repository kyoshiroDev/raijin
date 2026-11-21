import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { TokenRow } from '../../../shared/models/token';
import { CopyAddress } from '../../../shared/ui/copy-address';
import { Icon } from '../../../shared/ui/icon';
import { DEFAULT_STAKE_SOL } from '../../../shared/utils/stake';
import { ConfidenceBadge } from './confidence-badge';
import { FlagList } from './flag-list';
import { RoundtripLine } from './roundtrip-line';
import { TokenAvatar } from './token-avatar';
import { TokenBadges } from './token-badges';
import { TokenCardStats } from './token-card-stats';

export const MAX_CARD_FLAGS = 2;

/**
 * Visual card: factual badges (age, Calme / Frénésie, Sécurité OK / KO), key numbers grid with a 6 h sparkline and
 * the round-trip cost in SOL for the user's stake. The whole card opens the detail through a full-size transparent
 * button placed under the content ("stretched button"); the copy button and the liquidity info button stay
 * independently clickable on top.
 * Fills its grid cell (h-full) and pushes the actions to the bottom (mt-auto) so the copy buttons line up across a row.
 */
@Component({
  selector: 'app-token-card',
  imports: [ConfidenceBadge, CopyAddress, FlagList, Icon, RoundtripLine, TokenAvatar, TokenBadges, TokenCardStats],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block h-full min-w-0' },
  template: `
    @let t = token();
    <article
      class="card relative flex h-full flex-col transition-[border-color,transform] duration-150 has-[[data-open]:hover]:border-line-strong motion-safe:has-[[data-open]:active]:scale-[0.98]"
    >
      <button
        type="button"
        data-open
        class="absolute inset-0 rounded-2xl active:bg-surface-2/60 motion-safe:active:brightness-110"
        [attr.aria-label]="'Voir le détail de ' + t.symbol"
        (click)="open.emit()"
      ></button>
      <div class="pointer-events-none relative flex flex-1 flex-col gap-3">
        <header class="flex items-center gap-2.5">
          <app-token-avatar [imageUrl]="t.image_url" [symbol]="t.symbol" [mint]="t.mint" [size]="36" />
          <div class="min-w-0 flex-1">
            <h2 class="truncate font-bold">{{ t.symbol }}</h2>
            <p class="truncate text-xs text-muted">{{ t.name }}</p>
          </div>
          <app-icon name="chevron-right" class="size-4 text-muted" />
        </header>

        <app-token-badges [token]="t" />

        <app-token-card-stats [token]="t" />

        <app-roundtrip-line class="text-xs" [token]="t" [stake]="stake()" />

        <div class="flex min-h-5 flex-wrap items-start gap-1.5" data-signals>
          <app-confidence-badge [confidence]="t.data_confidence" />
          <app-flag-list class="min-w-0 max-w-full grow basis-48" [flags]="t.flags" [max]="maxFlags" compact />
        </div>

        <div class="pointer-events-auto mt-auto flex items-center gap-3" data-actions>
          <app-copy-address class="min-w-0 flex-1" [address]="t.mint" [label]="t.symbol" />
        </div>
      </div>
    </article>
  `,
})
export class TokenCard {
  readonly token = input.required<TokenRow>();
  /** User's usual stake in SOL (round-trip estimate). */
  readonly stake = input(DEFAULT_STAKE_SOL);
  readonly open = output<void>();

  /** Beyond this, flags fold into « +N » (full list in the detail). */
  protected readonly maxFlags = MAX_CARD_FLAGS;
}
