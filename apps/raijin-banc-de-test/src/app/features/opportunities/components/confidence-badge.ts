import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { DataConfidence } from '../../../shared/models/token';
import { confidenceBadge } from '../token-display';
import { Icon } from '../../../shared/ui/icon';

/** Cross-source data confidence, as text (never colour only). Nothing when unknown. */
@Component({
  selector: 'app-confidence-badge',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    @if (badge(); as b) {
      <span class="pill gap-1" [class]="b.className" [attr.data-confidence]="confidence()">
        <app-icon [name]="b.tone === 'bull' ? 'check' : b.tone === 'warn' ? 'minus' : 'alert'" class="size-3" />
        {{ b.label }}
      </span>
    }
  `,
})
export class ConfidenceBadge {
  readonly confidence = input<DataConfidence | null>(null);
  protected readonly badge = computed(() => confidenceBadge(this.confidence()));
}
