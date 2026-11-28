import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppUpdate } from './core/pwa/app-update';
import { UpdateToast } from './shared/ui/update-toast';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, UpdateToast],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <router-outlet />
    @if (update.updateReady()) {
      <app-update-toast [reloading]="update.reloading()" (reload)="update.reload()" (dismiss)="update.dismiss()" />
    }
  `,
})
export class App {
  protected readonly update = inject(AppUpdate);
}
