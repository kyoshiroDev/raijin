import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { backfillSummaryText, categoryText, donePercent, type BackfillProgress } from '../backfill';
import type { BackfillState } from '../strategy-lab-store';

/**
 * Server catch-up gauge (rpc('backfill_progress')): one accessible progress bar per category (done / total, due now,
 * last 24 h), then the measured throughput and the estimated end (presentational).
 */
@Component({
  selector: 'app-backfill-gauge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card block space-y-3 p-3', 'data-backfill': '' },
  template: `
    @switch (state()) {
      @case ('ready') {
        @if (progress(); as p) {
          <ul class="space-y-2.5">
            @for (c of rows(); track c.id) {
              <li class="space-y-1" [attr.data-backfill-category]="c.id">
                <div class="flex items-baseline justify-between gap-2 text-xs">
                  <span class="font-semibold" [id]="'backfill-' + c.id">{{ c.label }}</span>
                  <span class="text-muted tabular-nums">{{ c.percent }} %</span>
                </div>
                <div
                  class="h-2 overflow-hidden rounded-full bg-surface-2"
                  role="progressbar"
                  aria-valuemin="0"
                  [attr.aria-valuemax]="c.total"
                  [attr.aria-valuenow]="c.done"
                  [attr.aria-valuetext]="c.text"
                  [attr.aria-labelledby]="'backfill-' + c.id"
                >
                  <div class="h-full rounded-full bg-info" [style.width.%]="c.percent"></div>
                </div>
                <p class="text-label text-muted tabular-nums slashed-zero" data-backfill-detail>
                  {{ c.text }}
                </p>
              </li>
            }
          </ul>
          <p
            class="text-xs text-muted tabular-nums slashed-zero"
            role="status"
            data-backfill-summary
          >
            {{ summaryText(p) }}
          </p>
        }
      }
      @case ('error') {
        <p class="text-sm text-muted" role="status" data-backfill-error>
          Jauge du rattrapage momentanément illisible. Réessaie avec « Actualiser ».
        </p>
      }
      @default {
        <p class="text-sm text-muted" role="status" data-backfill-unavailable>
          Jauge du rattrapage pas encore disponible côté serveur.
        </p>
      }
    }
  `,
})
export class BackfillGauge {
  readonly progress = input<BackfillProgress | null>(null);
  readonly state = input<BackfillState>('idle');

  protected readonly summaryText = backfillSummaryText;
  protected readonly rows = computed(() =>
    (this.progress()?.categories ?? []).map((c) => ({
      ...c,
      percent: donePercent(c),
      text: categoryText(c),
    })),
  );
}
