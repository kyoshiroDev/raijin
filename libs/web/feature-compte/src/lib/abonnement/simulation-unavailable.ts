import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { RjButton, RjMascot } from '@raijin/web-ui';

/** Page de simulation ouverte alors que l'API n'est pas en mode simulé (Stripe réel ou indisponible). */
@Component({
  selector: 'rj-simulation-unavailable',
  imports: [RouterLink, RjButton, RjMascot],
  template: `
    <rj-mascot pose="alerte" size="md" />
    <div class="flex max-w-sm flex-col gap-2">
      <h1 class="font-display text-h3 text-ink">Cette page n’est pas disponible</h1>
      <p class="text-body text-ink-muted">Le paiement simulé ne sert qu’au développement de Raijin. Ton abonnement se gère depuis la page Abonnement.</p>
    </div>
    <a rjButton="secondary" routerLink="/abonnement">Voir l’abonnement</a>
  `,
  host: { role: 'alert', class: 'flex flex-col items-center gap-4 px-4 py-8 text-center md:py-12', 'data-simulation-unavailable': '' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjSimulationUnavailable {}
