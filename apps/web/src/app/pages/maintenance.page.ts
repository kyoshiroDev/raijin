import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { safeRedirect } from '@raijin/web-data-access';
import { RjButton, RjStatusPage } from '@raijin/web-ui';

/**
 * `/maintenance` : affichée quand l'API répond 503 `MAINTENANCE` (intercepteur de
 * web-data-access). « Réessayer » repart vers l'écran demandé (`redirect`, chemin interne validé).
 */
@Component({
  selector: 'rj-maintenance-page',
  imports: [RjButton, RjStatusPage],
  template: `
    <rj-status-page
      eyebrow="Maintenance"
      title="Raijin fait une courte pause"
      description="On met Raijin à jour. Tes suivis sont conservés et reprennent dès la fin de la maintenance. Réessaie dans quelques minutes."
    >
      <button type="button" rjButton="primary" size="lg" icon="retry" (click)="retry()">Réessayer</button>
    </rj-status-page>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MaintenancePage {
  private readonly router = inject(Router);
  /** Paramètre `?redirect=` (non fiable). */
  readonly redirect = input<string>();
  private readonly target = computed(() => safeRedirect(this.redirect(), '/analyse'));

  protected retry(): void {
    void this.router.navigateByUrl(this.target());
  }
}
