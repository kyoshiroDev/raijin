import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { emailSchema, opaqueTokenSchema } from '@raijin/shared-contracts';
import { AuthStore, toClientError } from '@raijin/web-data-access';
import { RjButton, RjIcon, RjInputField, RjSkeleton, RjToastService } from '@raijin/web-ui';
import { RjAuthLayout } from '../shared/auth-layout';
import { injectStripToken } from '../shared/strip-token';
import { createCooldown } from '../shared/cooldown';
import { TEXT_LINK } from '../shared/links';
import { RjResultPanel } from '../shared/result-panel';

type Phase = 'pending' | 'verifying' | 'verified' | 'invalid';

/**
 * Vérification d'e-mail. Avec `?token=` (lien de l'e-mail) : vérification, puis Rai bravo ou
 * Rai alerte. Sans jeton : « Vérifie ta boîte » et renvoi de l'e-mail (connecté ou non).
 * Le jeton est retiré de l'URL dès sa lecture.
 */
@Component({
  selector: 'rj-verify-email-page',
  imports: [NgTemplateOutlet, RouterLink, RjAuthLayout, RjButton, RjIcon, RjInputField, RjSkeleton, RjResultPanel],
  template: `
    @switch (phase()) {
      @case ('verifying') {
        <rj-auth-layout>
          <div class="flex flex-col items-center gap-4 py-6 text-center" aria-busy="true">
            <rj-skeleton shape="circle" class="size-24" />
            <h1 class="font-display text-h2 text-ink">Vérification en cours…</h1>
            <rj-skeleton class="h-4 w-56" />
          </div>
        </rj-auth-layout>
      }
      @case ('verified') {
        <rj-auth-layout>
          <rj-result-panel pose="bravo" title="Adresse confirmée" description="Ton compte Raijin est actif. Tu peux analyser un token avant de signer quoi que ce soit.">
            <a rjButton="primary" size="lg" [block]="true" routerLink="/analyse" iconEnd="arrowRight">Analyser un token</a>
            <a rjButton="ghost" [block]="true" routerLink="/compte">Voir mon compte</a>
          </rj-result-panel>
        </rj-auth-layout>
      }
      @case ('invalid') {
        <rj-auth-layout>
          <rj-result-panel pose="alerte" title="Lien expiré ou déjà utilisé" description="Ce lien de confirmation n’est plus valide. Demande un nouvel e-mail, il arrive en quelques secondes." />
          <ng-container *ngTemplateOutlet="resendForm" />
        </rj-auth-layout>
      }
      @default {
        <rj-auth-layout title="Vérifie ta boîte mail">
          @if (store.isAuthenticated() && store.emailVerified()) {
            <p class="flex items-center gap-2 text-body text-ink" role="status">
              <rj-icon name="circleCheck" class="text-safe" />Ton adresse e-mail est déjà confirmée.
            </p>
            <a rjButton="secondary" [block]="true" routerLink="/compte">Retour au compte</a>
          } @else {
            <div class="flex items-start gap-4">
              <span class="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-thunder-soft text-thunder-ink">
                <rj-icon name="mailCheck" [size]="24" />
              </span>
              <p class="text-body text-ink-muted">
                @if (store.user(); as user) {
                  Un lien de confirmation a été envoyé à <strong class="font-semibold wrap-anywhere text-ink">{{ user.email }}</strong>.
                } @else {
                  Un lien de confirmation t’a été envoyé à l’inscription.
                }
                Il reste valable 24 heures.
              </p>
            </div>
            <ng-container *ngTemplateOutlet="resendForm" />
            @if (store.isAuthenticated()) {
              <button type="button" rjButton="ghost" [block]="true" icon="retry" [loading]="checking()" (click)="checkAgain()">
                J’ai confirmé, actualiser
              </button>
            }
          }
          <ng-container rjAuthFooter>
            @if (store.isAuthenticated()) {
              <a routerLink="/compte" [class]="link">Retour au compte</a>
            } @else {
              <span>Déjà confirmé&nbsp;?</span>
              <a routerLink="/compte/connexion" [class]="link">Se connecter</a>
            }
          </ng-container>
        </rj-auth-layout>
      }
    }

    <ng-template #resendForm>
      <form class="flex flex-col gap-4" novalidate (submit)="resend($event)">
        @if (!store.isAuthenticated()) {
          <rj-input-field
            label="Adresse e-mail"
            name="email"
            type="email"
            inputmode="email"
            autocomplete="email"
            enterkeyhint="send"
            [required]="true"
            [maxlength]="254"
            [value]="email()"
            [error]="emailError()"
            (valueChange)="email.set($event); emailError.set('')"
          />
        }
        <button type="submit" [rjButton]="phase() === 'invalid' ? 'primary' : 'secondary'" [block]="true" icon="mail" [loading]="sending()" [disabled]="cooldown.active()">
          {{ cooldown.active() ? 'Renvoyer dans ' + cooldown.remaining() + ' s' : 'Renvoyer l’e-mail' }}
        </button>
      </form>
    </ng-template>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VerifyEmailPage implements OnInit {
  protected readonly store = inject(AuthStore);
  private readonly stripToken = injectStripToken();
  private readonly toasts = inject(RjToastService);

  readonly token = input<string>();

  protected readonly link = TEXT_LINK;
  protected readonly phase = signal<Phase>('pending');
  protected readonly email = signal('');
  protected readonly emailError = signal('');
  protected readonly sending = signal(false);
  protected readonly checking = signal(false);
  protected readonly cooldown = createCooldown(60);

  ngOnInit(): void {
    const raw = this.token();
    if (raw === undefined) return;
    this.stripToken();
    const parsed = opaqueTokenSchema.safeParse(raw);
    if (!parsed.success) {
      this.phase.set('invalid');
      return;
    }
    void this.verify(parsed.data);
  }

  private async verify(token: string): Promise<void> {
    this.phase.set('verifying');
    try {
      await this.store.verifyEmail(token);
      this.phase.set('verified');
    } catch {
      this.phase.set('invalid');
    }
  }

  protected async resend(event: Event): Promise<void> {
    event.preventDefault();
    if (this.sending() || this.cooldown.active()) return;
    let email: string | undefined;
    if (!this.store.isAuthenticated()) {
      const parsed = emailSchema.safeParse(this.email());
      if (!parsed.success) {
        this.emailError.set(parsed.error.issues[0]?.message ?? 'Adresse e-mail invalide.');
        return;
      }
      email = parsed.data;
    }
    this.sending.set(true);
    try {
      await this.store.resendVerification(email);
      this.cooldown.start();
      this.toasts.show('Si cette adresse attend une confirmation, un nouvel e-mail est en route.', { tone: 'success' });
    } catch (error) {
      this.toasts.show(toClientError(error).message, { tone: 'error' });
    } finally {
      this.sending.set(false);
    }
  }

  protected async checkAgain(): Promise<void> {
    this.checking.set(true);
    try {
      await this.store.reloadUser();
      if (this.store.emailVerified()) this.phase.set('verified');
      else this.toasts.show('Ton adresse n’est pas encore confirmée. Ouvre le lien reçu par e-mail.');
    } catch (error) {
      this.toasts.show(toClientError(error).message, { tone: 'error' });
    } finally {
      this.checking.set(false);
    }
  }
}
