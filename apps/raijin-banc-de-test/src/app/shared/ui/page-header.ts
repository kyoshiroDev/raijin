import { ChangeDetectionStrategy, Component } from '@angular/core';
import { BenchBadge } from './bench-badge';

/**
 * Sticky page header that clears the notch / Dynamic Island (viewport-fit=cover).
 * The host itself is sticky so it sticks for the whole page, not just its own box.
 * Always ends with the permanent « BANC DE TEST » badge.
 */
@Component({
  selector: 'app-page-header',
  imports: [BenchBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'sticky top-0 z-10 block border-b border-line bg-base/90 backdrop-blur safe-top safe-x' },
  template: `
    <div class="mx-auto flex min-h-14 max-w-5xl items-center gap-3 px-4 py-2">
      <ng-content />
      <app-bench-badge />
    </div>
  `,
})
export class PageHeader {}
