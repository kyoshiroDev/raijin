import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AUTH_ROUTES, AuthStore, WatchesStore, watchLimitExplanation, type ClientError } from '@raijin/web-data-access';
import { RjBottomSheet, RjButton, RjToastService } from '@raijin/web-ui';

/** Codes qui demandent une (re)connexion. */
const LOGIN_CODES: readonly string[] = ['UNAUTHORIZED', 'AUTH_SESSION_EXPIRED', 'AUTH_REFRESH_INVALID'];

/**
 * Bouton « Suivre » de l'écran d'analyse (chargé à l'inactivité, après le verdict).
 * - visiteur : connexion, puis retour sur cette analyse ;
 * - e-mail non confirmé : explication et lien de confirmation ;
 * - limite du plan atteinte (`WATCH_LIMIT_REACHED`) : bottom sheet explicative, sans urgence ;
 * - déjà suivi : état « Suivi » (bouton pressé), « Ne plus suivre » après confirmation.
 */
@Component({
  selector: 'rj-follow-button',
  imports: [RouterLink, RjBottomSheet, RjButton],
  template: `
    <button
      #followButton
      type="button"
      rjButton="secondary"
      [icon]="watch() ? 'following' : 'follow'"
      [block]="true"
      [loading]="busy()"
      [attr.aria-pressed]="watch() ? 'true' : 'false'"
      data-follow
      (click)="onClick()"
    >
      {{ watch() ? 'Suivi' : 'Suivre' }}
    </button>

    <rj-bottom-sheet [(open)]="limitOpen" title="Limite de suivis atteinte" [description]="limitText()">
      <p class="pb-2 text-body text-ink-muted">
        Un suivi en pause reste dans ta liste : tu peux le reprendre plus tard, sans perdre son historique d’alertes.
      </p>
      @if (canUpgrade()) {
        <p class="pb-2" data-limit-upgrade><a routerLink="/abonnement" [class]="textLink" (click)="limitOpen.set(false)">Voir l’offre Pro</a></p>
      }
      <button rjSheetFooter type="button" rjButton="ghost" (click)="limitOpen.set(false)">Fermer</button>
      <a rjSheetFooter rjButton="secondary" icon="suivis" routerLink="/suivis" (click)="limitOpen.set(false)">Gérer mes suivis</a>
    </rj-bottom-sheet>

    <rj-bottom-sheet
      [(open)]="verifyOpen"
      title="Confirme ton adresse e-mail"
      description="Raijin envoie les alertes de suivi par e-mail : il a besoin d’une adresse confirmée avant de suivre un token."
    >
      <button rjSheetFooter type="button" rjButton="ghost" (click)="verifyOpen.set(false)">Plus tard</button>
      <a rjSheetFooter rjButton="secondary" icon="mail" [routerLink]="verifyPath" (click)="verifyOpen.set(false)">Confirmer l’adresse</a>
    </rj-bottom-sheet>

    <rj-bottom-sheet
      [(open)]="unfollowOpen"
      title="Ne plus suivre ce token ?"
      description="Raijin arrête de le surveiller et tu ne recevras plus d’alerte pour lui. Les alertes déjà reçues restent dans ton historique."
    >
      <button rjSheetFooter type="button" rjButton="ghost" (click)="unfollowOpen.set(false)">Annuler</button>
      <button rjSheetFooter type="button" rjButton="danger" icon="bellOff" [loading]="busy()" (click)="unfollow()">Ne plus suivre</button>
    </rj-bottom-sheet>
  `,
  host: { class: 'grid' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjFollowButton {
  private readonly auth = inject(AuthStore);
  private readonly watches = inject(WatchesStore);
  private readonly router = inject(Router);
  private readonly toasts = inject(RjToastService);

  readonly mint = input.required<string>();
  /**
   * `true` : le visiteur a déjà appuyé sur le bouton provisoire (chargé à la demande) ; l'appui est rejoué au
   * premier rendu et le focus passe sur ce bouton.
   */
  readonly autoStart = input(false);
  private readonly followButton = viewChild('followButton', { read: ElementRef<HTMLButtonElement> });

  protected readonly verifyPath = AUTH_ROUTES.verifyEmail;
  protected readonly limitOpen = signal(false);
  protected readonly verifyOpen = signal(false);
  protected readonly unfollowOpen = signal(false);
  protected readonly watch = computed(() => this.watches.items().find((watch) => watch.mint === this.mint()) ?? null);
  protected readonly busy = computed(() => {
    const watch = this.watch();
    return this.watches.isBusy(this.mint()) || (watch !== null && this.watches.isBusy(watch.id));
  });
  protected readonly limitText = computed(() => watchLimitExplanation(this.watches.limits()));
  /** Lien vers l'abonnement seulement en Gratuit (hors essai), sans urgence. */
  protected readonly canUpgrade = computed(() => {
    const limits = this.watches.limits();
    return !!limits && limits.plan === 'FREE' && !limits.trialActive;
  });
  protected readonly textLink =
    'inline-flex min-h-11 items-center rounded-sm font-medium text-ink underline decoration-line-strong underline-offset-4 transition-colors duration-150 ease-raijin hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

  constructor() {
    afterNextRender(() => {
      if (!this.autoStart()) return;
      this.followButton()?.nativeElement.focus();
      void this.onClick();
    });
    // État « Suivi » : la liste est lue une fois la session connue (jamais pour un visiteur).
    effect(() => {
      if (this.auth.isAuthenticated() && this.auth.emailVerified()) untracked(() => void this.watches.load());
    });
  }

  protected async onClick(): Promise<void> {
    if (this.busy()) return;
    if (this.watch()) {
      this.unfollowOpen.set(true);
      return;
    }
    await this.auth.whenReady();
    if (!this.auth.isAuthenticated()) {
      await this.goToLogin();
      return;
    }
    if (!this.auth.emailVerified()) {
      this.verifyOpen.set(true);
      return;
    }
    const outcome = await this.watches.follow(this.mint());
    if (outcome.ok) {
      this.toasts.show('Raijin suit ce token : tu seras prévenu si un signal de risque apparaît.', { tone: 'success' });
      return;
    }
    await this.handleError(outcome.error);
  }

  protected async unfollow(): Promise<void> {
    const watch = this.watch();
    if (!watch) return;
    const outcome = await this.watches.remove(watch.id);
    this.unfollowOpen.set(false);
    if (outcome.ok) {
      this.toasts.show('Tu ne suis plus ce token.');
    } else {
      this.toasts.show(outcome.error.message, { tone: 'error' });
    }
  }

  private async handleError(error: ClientError): Promise<void> {
    if (error.code === 'WATCH_LIMIT_REACHED') {
      // Limites à jour pour l'explication (plan, essai), sans bloquer l'ouverture.
      void this.watches.load(true);
      this.limitOpen.set(true);
    } else if (error.code === 'AUTH_EMAIL_NOT_VERIFIED') {
      this.verifyOpen.set(true);
    } else if (LOGIN_CODES.includes(error.code)) {
      await this.goToLogin();
    } else {
      this.toasts.show(error.message, { tone: 'error' });
    }
  }

  private goToLogin(): Promise<boolean> {
    return this.router.navigate([AUTH_ROUTES.login], { queryParams: { redirect: `/analyse/${this.mint()}` } });
  }
}
