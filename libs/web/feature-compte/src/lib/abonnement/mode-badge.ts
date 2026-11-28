import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RjIcon } from '@raijin/web-ui';

/** Badge « Mode simulation » : aucun paiement réel (FakeBillingProvider, dev et tests seulement). */
@Component({
  selector: 'rj-mode-badge',
  imports: [RjIcon],
  template: `<rj-icon name="info" [size]="16" class="text-info" /><span>Mode simulation : aucun paiement réel</span>`,
  host: {
    class: 'inline-flex items-center gap-1.5 rounded-sm border border-line-strong bg-surface-raised px-2 py-1 text-label text-ink',
    'data-mode-badge': '',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjModeBadge {}
