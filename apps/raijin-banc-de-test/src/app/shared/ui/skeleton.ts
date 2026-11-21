import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type SkeletonVariant = 'token-card' | 'candidate-card' | 'wallet' | 'rows' | 'detail';

/**
 * Loading placeholders shaped like the content they announce (no « Chargement… » text on screen).
 * One live region (role="status") with a visually hidden label for screen readers; the blocks are aria-hidden.
 * Shimmer comes from the `.skeleton` primitive and only runs without prefers-reduced-motion.
 */
@Component({
  selector: 'app-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', role: 'status', 'aria-busy': 'true', '[attr.data-skeleton]': 'variant()' },
  template: `
    <span class="sr-only">{{ label() }}</span>
    <div aria-hidden="true" [class]="gridClass()">
      @for (i of items(); track i) {
        @switch (variant()) {
          @case ('token-card') {
            <div class="card flex flex-col gap-3" data-skeleton-item>
              <div class="flex items-center gap-2.5">
                <div class="skeleton size-11 rounded-full"></div>
                <div class="skeleton size-9 rounded-full"></div>
                <div class="flex-1 space-y-1.5"><div class="skeleton h-4 w-24"></div><div class="skeleton h-3 w-36"></div></div>
              </div>
              <div class="skeleton h-5 w-28 rounded-full"></div>
              <div class="skeleton h-1.5 w-full rounded-full"></div>
              <div class="grid grid-cols-3 gap-3">
                @for (c of six; track c) {
                  <div class="space-y-1"><div class="skeleton h-2.5 w-8"></div><div class="skeleton h-4 w-14"></div></div>
                }
              </div>
              <div class="skeleton mt-2 h-11 w-full rounded-xl"></div>
            </div>
          }
          @case ('candidate-card') {
            <div class="card flex flex-col gap-3" data-skeleton-item>
              <div class="flex items-center gap-3">
                <div class="flex-1 space-y-1.5"><div class="skeleton h-4 w-20"></div><div class="skeleton h-3 w-32"></div></div>
                <div class="skeleton h-6 w-10 rounded-full"></div>
              </div>
              <div class="skeleton h-8 w-full"></div>
              <div class="skeleton h-3 w-2/3"></div>
              <div class="skeleton h-11 w-full rounded-xl"></div>
            </div>
          }
          @case ('wallet') {
            <div class="card space-y-4" data-skeleton-item>
              <div class="space-y-2"><div class="skeleton h-3 w-32"></div><div class="skeleton h-8 w-40"></div></div>
              <div class="grid grid-cols-2 gap-3">
                <div class="space-y-1.5"><div class="skeleton h-3 w-24"></div><div class="skeleton h-5 w-20"></div></div>
                <div class="space-y-1.5"><div class="skeleton h-3 w-16"></div><div class="skeleton h-5 w-24"></div></div>
              </div>
              <div class="skeleton h-11 w-full rounded-xl"></div>
            </div>
          }
          @case ('detail') {
            <div class="card space-y-4" data-skeleton-item>
              <div class="flex items-center gap-3">
                <div class="skeleton size-12 rounded-full"></div>
                <div class="flex-1 space-y-1.5"><div class="skeleton h-5 w-28"></div><div class="skeleton h-3 w-40"></div></div>
              </div>
              <div class="skeleton h-[200px] w-full rounded-lg"></div>
              <div class="grid grid-cols-2 gap-3">
                @for (c of six; track c) {
                  <div class="space-y-1"><div class="skeleton h-2.5 w-16"></div><div class="skeleton h-4 w-24"></div></div>
                }
              </div>
            </div>
          }
          @default {
            <div class="card flex items-center gap-3" data-skeleton-item>
              <div class="flex-1 space-y-1.5"><div class="skeleton h-4 w-24"></div><div class="skeleton h-3 w-40"></div></div>
              <div class="skeleton h-5 w-16"></div>
            </div>
          }
        }
      }
    </div>
  `,
})
export class Skeleton {
  readonly variant = input<SkeletonVariant>('rows');
  /** Number of placeholders. */
  readonly count = input(1);
  /** Screen-reader text of the live region. */
  readonly label = input('Chargement…');

  protected readonly six = [0, 1, 2, 3, 4, 5];
  protected readonly items = computed(() => {
    const n = Number.isFinite(this.count()) ? Math.trunc(this.count()) : 1;
    return Array.from({ length: Math.max(1, Math.min(12, n)) }, (_, i) => i);
  });
  protected readonly gridClass = computed(() =>
    this.variant() === 'token-card' || this.variant() === 'candidate-card'
      ? 'grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3'
      : 'space-y-3',
  );
}
