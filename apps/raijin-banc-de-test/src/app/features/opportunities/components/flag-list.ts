import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from '@angular/core';

/**
 * Warning flags (score engine output, may embed token text: interpolation only).
 * `max` caps the number of pills shown (the rest becomes « +N »); `compact` keeps the whole list on one line
 * (pills shrink and truncate, full text in the title).
 */
@Component({
  selector: 'app-flag-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (flags().length) {
      <ul class="flex gap-1.5" [class.flex-wrap]="!compact()" aria-label="Points d’attention">
        @for (flag of shown(); track flag) {
          <li
            class="pill max-w-full bg-warn/10 text-warn"
            [class.wrap-anywhere]="!compact()"
            [class.min-w-0]="compact()"
            [attr.title]="compact() ? flag : null"
          >
            <span aria-hidden="true" class="shrink-0">⚠&nbsp;</span><span class="min-w-0" [class.truncate]="compact()">{{ flag }}</span>
          </li>
        }
        @if (hidden() > 0) {
          <li class="pill shrink-0 bg-warn/10 text-warn tabular-nums slashed-zero" data-more-flags>
            <span aria-hidden="true">+{{ hidden() }}</span>
            <span class="sr-only">{{ hiddenLabel() }}</span>
          </li>
        }
      </ul>
    } @else if (emptyText(); as empty) {
      <p class="text-sm text-muted">{{ empty }}</p>
    }
  `,
})
export class FlagList {
  readonly flags = input.required<readonly string[]>();
  readonly emptyText = input<string | null>(null);
  /** Maximum number of flags rendered; null = all. */
  readonly max = input<number | null>(null);
  readonly compact = input(false, { transform: booleanAttribute });

  protected readonly shown = computed(() => visibleFlags(this.flags(), this.max()).shown);
  protected readonly hidden = computed(() => visibleFlags(this.flags(), this.max()).hidden);
  protected readonly hiddenLabel = computed(() => {
    const n = this.hidden();
    return `${n} autre${n > 1 ? 's' : ''} signa${n > 1 ? 'ux' : 'l'}, voir la fiche`;
  });
}

/** Splits flags into the ones displayed and the count folded into « +N ». */
export function visibleFlags(flags: readonly string[], max: number | null): { shown: readonly string[]; hidden: number } {
  if (max === null || !Number.isFinite(max) || flags.length <= max) return { shown: flags, hidden: 0 };
  const cap = Math.max(0, Math.floor(max));
  return { shown: flags.slice(0, cap), hidden: flags.length - cap };
}
