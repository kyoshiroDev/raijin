import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Stat } from '@raijin/bench-web-logic/opportunities';

@Component({
  selector: 'app-stat-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <dl class="grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm tabular-nums slashed-zero">
      @for (s of stats(); track s.label) {
        <div class="min-w-0">
          <dt class="text-xs text-muted">{{ s.label }}</dt>
          <dd
            class="wrap-anywhere"
            [class.font-mono]="s.mono"
            [class.text-bull]="s.tone === 'bull'"
            [class.text-bear]="s.tone === 'bear'"
            [class.text-warn]="s.tone === 'warn'"
          >
            {{ s.value }}
          </dd>
        </div>
      }
    </dl>
  `,
})
export class StatGrid {
  readonly stats = input.required<readonly Stat[]>();
}
