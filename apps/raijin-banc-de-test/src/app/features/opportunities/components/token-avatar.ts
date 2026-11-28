import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';
import { safeExternalUrl, avatarBackground, avatarLetter } from '@raijin/bench-web-logic';

/**
 * Token logo from an allowlisted host (safeExternalUrl), lazy, no referrer, fixed size. Fallback (no URL,
 * rejected URL or load error): a generated avatar, colour derived from the mint (deterministic) and the first
 * letter of the symbol (hostile text: interpolation only).
 */
@Component({
  selector: 'app-token-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block shrink-0',
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
  },
  template: `
    @if (src() && !failed()) {
      <img
        [src]="src()"
        alt=""
        [width]="size()"
        [height]="size()"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
        class="size-full rounded-full bg-surface-2 object-cover"
        (error)="failed.set(true)"
      />
    } @else {
      <div
        class="grid size-full place-items-center overflow-hidden rounded-full font-bold select-none"
        [class.bg-surface-2]="!background()"
        [class.text-muted]="!background()"
        [class.text-fg]="!!background()"
        [style.background-color]="background()"
        [style.font-size.px]="fontSize()"
        aria-hidden="true"
        data-avatar-fallback
      >
        {{ letter() }}
      </div>
    }
  `,
})
export class TokenAvatar {
  readonly imageUrl = input<string | null>(null);
  readonly symbol = input('');
  /** Mint address, seeds the fallback colour (neutral when empty). */
  readonly mint = input('');
  readonly size = input(40);

  protected readonly src = computed(() => safeExternalUrl(this.imageUrl(), 'image'));
  protected readonly failed = linkedSignal({ source: this.src, computation: () => false });
  protected readonly letter = computed(() => avatarLetter(this.symbol()));
  protected readonly background = computed(() => avatarBackground(this.mint()));
  protected readonly fontSize = computed(() => Math.round(this.size() * 0.42));
}
