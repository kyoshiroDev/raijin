import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ALERT_STATUS, type AlertStatus } from '../alert-view';
import { Icon } from '../../../shared/ui/icon';

/** Follow-up badge: icon + text (never colour-only). */
@Component({
  selector: 'app-alert-status-badge',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex' },
  template: `
    <span class="pill inline-flex items-center gap-1 text-xs whitespace-nowrap" [class]="view().className" [attr.data-status]="status()">
      <app-icon [name]="view().icon" class="size-3.5" />
      {{ view().label }}
    </span>
  `,
})
export class AlertStatusBadge {
  readonly status = input.required<AlertStatus>();

  protected readonly view = computed(() => ALERT_STATUS[this.status()]);
}
