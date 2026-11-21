import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { BoltMark } from './bolt-mark';

/**
 * Illustrated empty state: dormant lightning, a title and a hint (fixed French copy from the caller, never token text).
 * Extra content (e.g. a link) is projected under the hint.
 */
@Component({
  selector: 'app-empty-state',
  imports: [BoltMark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="flex flex-col items-center gap-2 px-4 py-8 text-center" data-empty-state>
      <app-bolt-mark class="mb-1 size-14" tone="dormant" />
      <p class="font-semibold" data-empty-title>{{ title() }}</p>
      @if (hint()) {
        <p class="max-w-xs text-sm text-muted" data-empty-hint>{{ hint() }}</p>
      }
      <ng-content />
    </div>
  `,
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly hint = input('');
}
