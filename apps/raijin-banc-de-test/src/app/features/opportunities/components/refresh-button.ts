import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Icon } from '../../../shared/ui/icon';

@Component({
  selector: 'app-refresh-button',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'shrink-0' },
  template: `
    <button type="button" class="btn-ghost px-3 text-xs" [disabled]="loading()" [attr.aria-busy]="loading()" (click)="refresh.emit()">
      <app-icon name="refresh" class="size-4 motion-reduce:animate-none" [class.animate-spin]="loading()" />
      <span class="max-xs:sr-only">{{ loading() ? 'Chargement…' : 'Actualiser' }}</span>
    </button>
  `,
})
export class RefreshButton {
  readonly loading = input(false);
  readonly refresh = output<void>();
}
