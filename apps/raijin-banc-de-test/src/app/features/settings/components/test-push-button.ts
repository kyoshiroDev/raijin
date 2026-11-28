import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { TestPushState } from '../settings-store';

@Component({
  selector: 'app-test-push-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block space-y-2' },
  template: `
    <button type="button" class="btn-ghost w-full" [disabled]="disabled() || state() === 'pending'" (click)="send.emit()">
      {{ state() === 'pending' ? 'Envoi…' : 'Envoyer une notification de test' }}
    </button>
    <div aria-live="polite" class="text-center text-sm">
      @switch (state()) {
        @case ('sent') {
          @if (sent() > 0) {
            <p class="text-bull">Envoyée sur {{ sent() }} appareil(s)</p>
          } @else {
            <p class="text-warn">Aucun appareil joignable. Désactive puis réactive les notifications.</p>
          }
        }
        @case ('throttled') {
          <p class="text-warn">Patiente une minute entre deux tests</p>
        }
        @case ('error') {
          <p class="text-bear">Impossible d’envoyer la notification de test. Réessaie plus tard.</p>
        }
      }
    </div>
  `,
})
export class TestPushButton {
  readonly state = input<TestPushState>('idle');
  readonly sent = input(0);
  readonly disabled = input(false);
  readonly send = output();
}
