import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Icon } from './icon';

/** Permanent reminder on every paper-trading surface: nothing here is real money. */
@Component({
  selector: 'app-simulation-banner',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex items-center gap-2 rounded-xl border border-info/40 bg-info/10 px-3 py-2 text-sm font-semibold text-info',
    role: 'note',
    'data-simulation-banner': '',
  },
  template: `
    <app-icon name="info" class="size-4" />
    <span>Simulation — aucun argent réel</span>
  `,
})
export class SimulationBanner {}
