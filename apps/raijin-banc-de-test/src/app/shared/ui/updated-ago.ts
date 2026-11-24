import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { formatUpdatedAgo } from '@raijin/bench-web-logic';

export const UPDATED_AGO_TICK_MS = 30_000;

/** « Mis à jour il y a X min », refreshed every 30 s (timer cleaned up on destroy). */
@Component({
  selector: 'app-updated-ago',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', class: 'block tabular-nums slashed-zero' },
  template: `{{ label() }}`,
})
export class UpdatedAgo {
  readonly at = input<Date | string | null>(null);

  private readonly now = signal(Date.now());
  protected readonly label = computed(() => formatUpdatedAgo(this.at(), this.now()));

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), UPDATED_AGO_TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
}
