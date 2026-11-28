import { ChangeDetectionStrategy, Component, ElementRef, Injector, OnInit, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { opaqueTokenSchema } from '@raijin/shared-contracts';
import { AuthStore, safeRedirect, toClientError } from '@raijin/web-data-access';
import { RjButton, RjSkeleton } from '@raijin/web-ui';
import { RjAuthLayout } from '../shared/auth-layout';
import { focusPageTitle } from '../shared/focus';
import { injectStripToken } from '../shared/strip-token';
import { RjResultPanel } from '../shared/result-panel';

/**
 * Atterrissage du lien magique : jeton lu puis retiré de l'URL, session ouverte, retour vers
 * `redirect` validé par `relativePathSchema` (jamais une autre origine). Échec : Rai alerte.
 */
@Component({
  selector: 'rj-magic-link-verify-page',
  imports: [RouterLink, RjAuthLayout, RjButton, RjSkeleton, RjResultPanel],
  template: `
    <rj-auth-layout>
      @if (failed(); as message) {
        <rj-result-panel pose="alerte" title="Connexion impossible" [description]="message">
          <a rjButton="primary" size="lg" icon="mail" [block]="true" routerLink="/compte/lien-magique">Recevoir un nouveau lien</a>
          <a rjButton="ghost" [block]="true" routerLink="/compte/connexion">Se connecter avec un mot de passe</a>
        </rj-result-panel>
      } @else {
        <div class="flex flex-col items-center gap-4 py-6 text-center" aria-busy="true">
          <rj-skeleton shape="circle" class="size-24" />
          <h1 class="font-display text-h2 text-ink">Connexion en cours…</h1>
          <rj-skeleton class="h-4 w-56" />
        </div>
      }
    </rj-auth-layout>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MagicLinkVerifyPage implements OnInit {
  private readonly store = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly stripToken = injectStripToken();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);

  readonly token = input<string>();
  readonly redirect = input<string>();

  protected readonly failed = signal<string | null>(null);

  ngOnInit(): void {
    const parsed = opaqueTokenSchema.safeParse(this.token() ?? '');
    // Le jeton ne reste pas dans l'historique ni dans l'URL affichée.
    this.stripToken();
    if (!parsed.success) {
      this.failed.set('Ce lien de connexion est incomplet ou invalide. Demande-en un nouveau.');
      return;
    }
    void this.verify(parsed.data);
  }

  private async verify(token: string): Promise<void> {
    try {
      const { redirectPath } = await this.store.verifyMagicLink(token);
      // Cible mémorisée par l'API à la demande, sinon `?redirect=` ; toujours revalidée (pas de redirection ouverte).
      await this.router.navigateByUrl(safeRedirect(redirectPath ?? this.redirect()), { replaceUrl: true });
    } catch (error) {
      const clientError = toClientError(error);
      this.failed.set(
        clientError.code === 'AUTH_TOKEN_INVALID'
          ? 'Ce lien a expiré ou a déjà servi. Chaque lien n’est valable qu’une fois, pendant 15 minutes.'
          : clientError.message,
      );
      focusPageTitle(this.host, this.injector);
    }
  }
}
