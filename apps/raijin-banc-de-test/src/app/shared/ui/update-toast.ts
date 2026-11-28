import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Icon } from './icon';

/** « Nouvelle version disponible » banner, shown above the bottom tab bar. */
@Component({
  selector: 'app-update-toast',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'status',
    'aria-live': 'polite',
    class: 'fixed inset-x-0 z-40 block px-safe bottom-[calc(var(--spacing-nav)+env(safe-area-inset-bottom)+0.75rem)] animate-fade-in',
  },
  template: `
    <div class="card mx-auto flex max-w-lg items-center gap-2 border-line-strong py-2 pr-2 shadow-lg shadow-black/40">
      <p class="min-w-0 flex-1 text-sm font-semibold">Nouvelle version disponible</p>
      <button type="button" class="btn-primary" [disabled]="reloading()" (click)="reload.emit()">
        {{ reloading() ? 'Rechargement…' : 'Recharger' }}
      </button>
      <button type="button" class="btn size-11 px-0 text-muted hover:text-fg" aria-label="Ignorer la mise à jour" (click)="dismiss.emit()">
        <app-icon name="close" class="size-5" />
      </button>
    </div>
  `,
})
export class UpdateToast {
  readonly reloading = input(false);
  readonly reload = output();
  readonly dismiss = output();
}
