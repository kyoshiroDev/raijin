import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, Injector, afterNextRender, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { PLAN_LABELS, type PublicUser } from '@raijin/shared-contracts';
import { AuthStore, PushService, UnreadAlerts, WatchesStore, toClientError } from '@raijin/web-data-access';
import { RjButton, RjCard, RjErrorState, RjIcon, RjSkeleton, RjToastService } from '@raijin/web-ui';
import { RjChangePasswordSheet } from '../account/change-password-sheet';
import { RjDeleteAccountSheet } from '../account/delete-account-sheet';
import { RjNotificationSettings } from '../account/notification-settings';
import { RjFormAlert } from '../shared/form-alert';
import { DISCLAIMER, TEXT_LINK } from '../shared/links';

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/** Texte de l'essai Pro (phase 6) : factuel, sans urgence ni promesse. */
export function trialText(user: PublicUser): string {
  const { status, endsAt } = user.trial;
  if (status === 'active' && endsAt) return `Essai Pro en cours jusqu’au ${DATE.format(new Date(endsAt))}.`;
  if (status === 'ended') return 'Ton essai Pro est terminé.';
  return user.plan === 'PRO' ? 'Toutes les fonctions Pro sont actives.' : 'Tu utilises la formule gratuite de Raijin.';
}

/**
 * Écran Compte : profil, plan, notifications, sécurité (mot de passe, déconnexion), données (export, suppression).
 * Skeleton pendant la récupération de la session, Rai alerte si l'API ne répond pas.
 * Boutons des cartes : côte à côte s'ils tiennent en entier, sinon empilés (jamais tronqués).
 * Aucune action jaune sur l'écran lui-même : chaque bottom sheet porte sa propre action principale.
 */
@Component({
  selector: 'rj-account-page',
  imports: [RouterLink, RjButton, RjCard, RjErrorState, RjIcon, RjSkeleton, RjFormAlert, RjChangePasswordSheet, RjDeleteAccountSheet, RjNotificationSettings],
  template: `
    @if (store.status() === 'error') {
      <rj-error-state
        title="Raijin n’a pas pu charger ton compte"
        description="Vérifie ta connexion puis réessaie. Tes données ne sont pas perdues."
        [retrying]="retrying()"
        (retry)="retry()"
      />
    } @else if (store.user(); as user) {
      <div class="flex flex-col gap-6 md:gap-8">
        <header class="flex flex-col gap-1">
          <h1 class="font-display text-h2 text-ink md:text-h1">Compte</h1>
          <p class="text-body text-ink-muted">Ton profil, tes notifications, ta sécurité et tes données.</p>
        </header>

        @if (!user.emailVerified) {
          <rj-form-alert tone="warn">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <span>Confirme ton adresse e-mail pour activer ton compte et l’essai Pro.</span>
              <a routerLink="/compte/verifier-email" [class]="link + ' shrink-0 sm:-my-3'">Confirmer l’adresse</a>
            </div>
          </rj-form-alert>
        }

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
          <rj-card>
            <h2 class="font-display text-h3 text-ink">Profil</h2>
            <dl class="flex flex-col divide-y divide-line">
              <div class="flex flex-col gap-0.5 py-3 first:pt-0">
                <dt class="text-body-sm text-ink-muted">Adresse e-mail</dt>
                <dd class="text-body wrap-anywhere text-ink">{{ user.email }}</dd>
              </div>
              <div class="flex flex-col gap-0.5 py-3">
                <dt class="text-body-sm text-ink-muted">Statut de l’adresse</dt>
                <dd class="flex items-center gap-1.5 text-body text-ink">
                  @if (user.emailVerified) {
                    <rj-icon name="circleCheck" [size]="16" class="text-safe" />Confirmée
                  } @else {
                    <rj-icon name="warn" [size]="16" class="text-warn" />À confirmer
                  }
                </dd>
              </div>
              <div class="flex flex-col gap-0.5 py-3 last:pb-0">
                <dt class="text-body-sm text-ink-muted">Membre depuis</dt>
                <dd class="text-body text-ink">{{ memberSince() }}</dd>
              </div>
            </dl>
          </rj-card>

          <rj-card>
            <h2 class="font-display text-h3 text-ink">Plan</h2>
            <div class="flex items-center gap-3">
              <span class="inline-flex items-center gap-1.5 rounded-sm border border-line-strong px-2 py-1 text-label font-semibold tracking-wide text-ink uppercase">
                <rj-icon name="safe" [size]="16" class="text-thunder-ink" />{{ planLabel() }}
              </span>
            </div>
            <p class="text-body text-ink-muted">{{ trial() }}</p>
            <p rjCardFooter class="text-body-sm text-ink-muted">Le détail des offres et la facturation arrivent bientôt ici.</p>
          </rj-card>

          <rj-notification-settings class="md:col-span-2" />

          <rj-card>
            <h2 class="font-display text-h3 text-ink">Sécurité</h2>
            <p class="text-body text-ink-muted">Change ton mot de passe ou ferme ta session sur cet appareil.</p>
            <div rjCardFooter class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button type="button" rjButton="secondary" icon="key" class="sm:shrink-0 sm:grow" (click)="passwordOpen.set(true)">Changer le mot de passe</button>
              <button type="button" rjButton="ghost" icon="logout" class="sm:shrink-0 sm:grow" [loading]="loggingOut()" (click)="logout()">Se déconnecter</button>
            </div>
          </rj-card>

          <rj-card>
            <h2 class="font-display text-h3 text-ink">Tes données</h2>
            <p class="text-body text-ink-muted">Télécharge une copie de tes données (JSON) ou supprime ton compte définitivement.</p>
            <div rjCardFooter class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button type="button" rjButton="secondary" icon="download" class="sm:shrink-0 sm:grow" [loading]="exporting()" (click)="exportData()">Exporter</button>
              <button type="button" rjButton="danger" icon="trash" class="sm:shrink-0 sm:grow" (click)="deleteOpen.set(true)">Supprimer le compte</button>
            </div>
          </rj-card>
        </div>

        <p class="text-label text-ink-muted">{{ disclaimer }}</p>
      </div>

      <rj-change-password-sheet [(open)]="passwordOpen" [email]="user.email" />
      <rj-delete-account-sheet [(open)]="deleteOpen" [email]="user.email" (deleted)="onDeleted()" />
    } @else {
      <div class="flex flex-col gap-6 md:gap-8" aria-busy="true" aria-label="Chargement du compte">
        <div class="flex flex-col gap-2">
          <rj-skeleton class="h-8 w-40 md:h-11" />
          <rj-skeleton class="h-5 w-56" />
        </div>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
          @for (card of skeletonCards; track card) {
            <rj-skeleton shape="block" class="h-48" />
          }
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountPage {
  protected readonly store = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly toasts = inject(RjToastService);
  private readonly document = inject(DOCUMENT);
  private readonly push = inject(PushService);
  private readonly watches = inject(WatchesStore);
  private readonly unread = inject(UnreadAlerts);
  private readonly injector = inject(Injector);

  /** `?section=notifications` (lien « préférences » des e-mails d'alerte) : défilement et focus sur la carte. */
  readonly section = input<string>();
  private sectionShown = false;

  protected readonly link = TEXT_LINK;
  protected readonly disclaimer = DISCLAIMER;
  protected readonly skeletonCards = [1, 2, 3, 4];
  protected readonly passwordOpen = signal(false);
  protected readonly deleteOpen = signal(false);
  protected readonly exporting = signal(false);
  protected readonly loggingOut = signal(false);
  protected readonly retrying = signal(false);

  protected readonly planLabel = computed(() => {
    const user = this.store.user();
    return user ? PLAN_LABELS[user.plan] : '';
  });
  protected readonly trial = computed(() => {
    const user = this.store.user();
    return user ? trialText(user) : '';
  });
  protected readonly memberSince = computed(() => {
    const user = this.store.user();
    return user ? DATE.format(new Date(user.createdAt)) : '';
  });

  constructor() {
    effect(() => {
      const ready = this.store.user() !== null;
      if (!ready || this.section() !== 'notifications' || this.sectionShown) return;
      this.sectionShown = true;
      untracked(() =>
        afterNextRender(
          () => {
            const view = this.document.defaultView;
            const reduce = view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true;
            this.document.getElementById('notifications')?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
            this.document.getElementById('rj-notifications-title')?.focus({ preventScroll: true });
          },
          { injector: this.injector },
        ),
      );
    });
    // Pas de garde bloquante : le skeleton s'affiche pendant la récupération de la session,
    // puis un visiteur est renvoyé vers la connexion (retour au compte ensuite).
    effect(() => {
      if (this.store.status() === 'anonymous' && !this.leaving) {
        this.leaving = true;
        void this.router.navigate(['/compte/connexion'], { queryParams: { redirect: this.section() === 'notifications' ? '/compte?section=notifications' : '/compte' }, replaceUrl: true });
      }
    });
  }

  /** Navigation déjà décidée (déconnexion, suppression, visiteur) : l'effet ne redirige pas une 2e fois. */
  private leaving = false;

  protected async retry(): Promise<void> {
    this.retrying.set(true);
    await this.store.init(true);
    this.retrying.set(false);
  }

  protected async logout(): Promise<void> {
    this.leaving = true;
    this.loggingOut.set(true);
    // Cet appareil ne doit plus recevoir les alertes du compte (désabonnement avant la fin de session).
    await this.push.disable();
    await this.store.logout();
    this.watches.reset();
    this.unread.set(0);
    this.loggingOut.set(false);
    this.toasts.show('Tu es déconnecté. À bientôt.');
    await this.router.navigateByUrl('/compte/connexion');
  }

  protected async exportData(): Promise<void> {
    this.exporting.set(true);
    try {
      const blob = await this.store.exportData();
      this.download(blob, `raijin-mes-donnees-${new Date().toISOString().slice(0, 10)}.json`);
      this.toasts.show('Export prêt : le fichier est dans tes téléchargements.', { tone: 'success' });
    } catch (error) {
      this.toasts.show(toClientError(error).message, { tone: 'error' });
    } finally {
      this.exporting.set(false);
    }
  }

  protected async onDeleted(): Promise<void> {
    this.leaving = true;
    this.toasts.show('Ton compte a été supprimé. Merci d’avoir utilisé Raijin.');
    await this.router.navigateByUrl('/analyse');
  }

  private download(blob: Blob, filename: string): void {
    const view = this.document.defaultView;
    if (!view?.URL?.createObjectURL) return;
    const url = view.URL.createObjectURL(blob);
    const anchor = this.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    this.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    view.setTimeout(() => view.URL.revokeObjectURL(url), 0);
  }
}
