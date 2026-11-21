import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RjIcon } from '../icon/icon';

export type RjVerdict = 'safe' | 'warn' | 'danger';

/** Mots imposés par la charte : un verdict s'affiche toujours avec une icône ET un mot. */
export const RJ_VERDICT_LABELS: Record<RjVerdict, string> = {
  safe: 'Sain',
  warn: 'Prudence',
  danger: 'Danger',
};

const TONES: Record<RjVerdict, string> = {
  safe: 'border-safe/40 bg-safe/10 text-safe',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  danger: 'border-danger/40 bg-danger/10 text-danger',
};

/** Badge de verdict : icône (bouclier-check, triangle, octogone-croix) + mot, coins `radius-sm`. */
@Component({
  selector: 'rj-verdict-badge',
  imports: [RjIcon],
  template: `
    <rj-icon [name]="verdict()" [size]="size() === 'lg' ? 20 : 16" />
    <span>{{ label() }}</span>
  `,
  host: {
    role: 'status',
    '[attr.aria-label]': '"Verdict : " + label()',
    '[attr.data-verdict]': 'verdict()',
    '[class]': 'classes()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjVerdictBadge {
  readonly verdict = input.required<RjVerdict>();
  readonly size = input<'md' | 'lg'>('md');

  protected readonly label = computed(() => RJ_VERDICT_LABELS[this.verdict()]);
  protected readonly classes = computed(() =>
    [
      'inline-flex shrink-0 items-center gap-1.5 rounded-sm border font-sans font-semibold',
      this.size() === 'lg' ? 'px-3 py-1.5 text-body' : 'px-2 py-1 text-body-sm',
      TONES[this.verdict()],
    ].join(' '),
  );
}
