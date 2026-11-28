import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RjButton, type RjButtonVariant } from '../button/button';
import { RjMascot } from '../mascot/mascot';

/** État d'erreur : Rai (pose alerte), un message factuel et le bouton « Réessayer ». */
@Component({
  selector: 'rj-error-state',
  imports: [RjMascot, RjButton],
  template: `
    <rj-mascot pose="alerte" size="md" />
    <div class="flex max-w-sm flex-col gap-2">
      <h2 class="font-display text-h3 text-ink">{{ title() }}</h2>
      @if (description(); as description) {
        <p class="text-body text-ink-muted">{{ description }}</p>
      }
    </div>
    <button type="button" [rjButton]="retryVariant()" icon="retry" [loading]="retrying()" (click)="retry.emit()">
      Réessayer
    </button>
  `,
  host: { role: 'alert', class: 'flex flex-col items-center gap-4 px-4 py-8 text-center md:py-12' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjErrorState {
  readonly title = input('Raijin n’a pas pu charger ces données');
  readonly description = input('Vérifie ta connexion puis réessaie. Si ça continue, le service source est peut-être indisponible.');
  /** Secondaire par défaut : l'écran garde le contrôle de son unique bouton jaune. */
  readonly retryVariant = input<RjButtonVariant>('secondary');
  readonly retrying = input(false);
  readonly retry = output<void>();
}
