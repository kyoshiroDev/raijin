import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type BoltTone = 'brand' | 'dormant';

/**
 * Stylised lightning (decorative, aria-hidden). `brand`: the accent bolt of the logo. `dormant`: a muted bolt in a
 * faint ring for empty states (no accent: nothing to act on). Size from the host class.
 */
@Component({
  selector: 'app-bolt-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-block shrink-0', 'aria-hidden': 'true', '[attr.data-tone]': 'tone()' },
  template: `
    <svg viewBox="0 0 48 48" width="100%" height="100%" class="block" focusable="false">
      @if (tone() === 'dormant') {
        <circle cx="24" cy="24" r="21" class="fill-surface-2 stroke-line" stroke-width="1.5" />
        <path d="M10 15h4M34 33h4M36 12l-2.5 2.5M12 36l2.5-2.5" class="stroke-line-strong" stroke-width="1.75" stroke-linecap="round" fill="none" />
        <path d="M26.5 9 15 26.5h8.5L21.5 39 33 21.5h-8.5L26.5 9Z" class="fill-surface-3 stroke-muted" stroke-width="1.75" stroke-linejoin="round" />
      } @else {
        <path d="M27.5 3 11 27h11l-2.5 18L36 21H25l2.5-18Z" class="fill-accent stroke-accent" stroke-width="1.5" stroke-linejoin="round" />
      }
    </svg>
  `,
})
export class BoltMark {
  readonly tone = input<BoltTone>('brand');
}
