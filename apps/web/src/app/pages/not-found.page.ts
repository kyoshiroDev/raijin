import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { RjButton, RjStatusPage } from '@raijin/web-ui';

/** Route `**` : page introuvable, Rai bravo et retour à l'analyse (seule action jaune). */
@Component({
  selector: 'rj-not-found-page',
  imports: [RouterLink, RjButton, RjStatusPage],
  template: `
    <rj-status-page
      eyebrow="Erreur 404"
      title="Cette page n’existe pas"
      description="Le lien est peut-être incomplet ou la page a changé d’adresse. Tes suivis et tes alertes ne sont pas touchés."
    >
      <a rjButton="primary" size="lg" routerLink="/analyse" icon="analyse">Analyser un token</a>
      <a rjButton="secondary" size="lg" routerLink="/suivis" icon="suivis">Mes suivis</a>
    </rj-status-page>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFoundPage {}
