import { ChangeDetectionStrategy, Component, ElementRef, Injector, OnInit, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PASSWORD_HINT, PASSWORD_RULES, newPasswordSchema, opaqueTokenSchema } from '@raijin/shared-contracts';
import { AuthStore, toClientError, type ClientError } from '@raijin/web-data-access';
import { RjButton, RjInputField } from '@raijin/web-ui';
import { z } from 'zod';
import { RjAuthLayout } from '../shared/auth-layout';
import { injectStripToken } from '../shared/strip-token';
import { focusFirstInvalid } from '../shared/focus';
import { RjFormAlert } from '../shared/form-alert';
import { TEXT_LINK } from '../shared/links';
import { RjResultPanel } from '../shared/result-panel';
import { zodForm } from '../shared/zod-form';

type Phase = 'form' | 'done' | 'invalid';

/** Le jeton est gardé en mémoire (retiré de l'URL) : le formulaire ne valide que le mot de passe. */
const passwordOnlySchema = z.object({ password: newPasswordSchema });

/**
 * Réinitialisation du mot de passe depuis le lien de l'e-mail. Succès : Rai bravo, toutes les
 * sessions sont fermées par l'API, l'utilisateur se reconnecte. Lien invalide : Rai alerte.
 */
@Component({
  selector: 'rj-reset-password-page',
  imports: [RouterLink, RjAuthLayout, RjButton, RjInputField, RjFormAlert, RjResultPanel],
  template: `
    @switch (phase()) {
      @case ('done') {
        <rj-auth-layout>
          <rj-result-panel pose="bravo" title="Mot de passe modifié" description="Par sécurité, toutes tes sessions ont été fermées. Connecte-toi avec ton nouveau mot de passe.">
            <a rjButton="primary" size="lg" [block]="true" routerLink="/compte/connexion">Se connecter</a>
          </rj-result-panel>
        </rj-auth-layout>
      }
      @case ('invalid') {
        <rj-auth-layout>
          <rj-result-panel pose="alerte" title="Lien expiré ou déjà utilisé" description="Ce lien de réinitialisation n’est plus valide. Il ne sert qu’une fois, pendant 30 minutes.">
            <a rjButton="primary" size="lg" [block]="true" routerLink="/compte/mot-de-passe-oublie">Demander un nouveau lien</a>
            <a rjButton="ghost" [block]="true" routerLink="/compte/connexion">Retour à la connexion</a>
          </rj-result-panel>
        </rj-auth-layout>
      }
      @default {
        <rj-auth-layout title="Nouveau mot de passe" subtitle="Choisis un mot de passe que tu n’utilises nulle part ailleurs.">
          <form class="flex flex-col gap-4" novalidate (submit)="submit($event)">
            @if (serverError(); as error) {
              <rj-form-alert>{{ error.message }}</rj-form-alert>
            }
            <rj-input-field
              label="Nouveau mot de passe"
              name="new-password"
              type="password"
              autocomplete="new-password"
              enterkeyhint="done"
              [revealable]="true"
              [required]="true"
              [maxlength]="maxPassword"
              [hint]="passwordHint"
              [value]="form.value().password"
              [error]="form.errors().password ?? ''"
              (valueChange)="form.set('password', $event)"
              (blurred)="form.touch('password')"
            />
            <button type="submit" rjButton="primary" size="lg" [block]="true" [loading]="pending()">Enregistrer le mot de passe</button>
          </form>
          <ng-container rjAuthFooter>
            <a routerLink="/compte/connexion" [class]="link">Retour à la connexion</a>
          </ng-container>
        </rj-auth-layout>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResetPasswordPage implements OnInit {
  private readonly store = inject(AuthStore);
  private readonly stripToken = injectStripToken();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private resetToken: string | null = null;

  readonly token = input<string>();

  protected readonly link = TEXT_LINK;
  protected readonly passwordHint = PASSWORD_HINT;
  protected readonly maxPassword = PASSWORD_RULES.maxLength;
  protected readonly form = zodForm(passwordOnlySchema, { password: '' });
  protected readonly phase = signal<Phase>('form');
  protected readonly pending = signal(false);
  protected readonly serverError = signal<ClientError | null>(null);

  ngOnInit(): void {
    const parsed = opaqueTokenSchema.safeParse(this.token() ?? '');
    this.stripToken();
    if (parsed.success) this.resetToken = parsed.data;
    else this.phase.set('invalid');
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.pending() || !this.resetToken) return;
    this.serverError.set(null);
    const body = this.form.submit();
    if (!body) {
      focusFirstInvalid(this.host, this.injector);
      return;
    }
    this.pending.set(true);
    try {
      await this.store.resetPassword({ token: this.resetToken, password: body.password });
      this.resetToken = null;
      this.phase.set('done');
    } catch (error) {
      const clientError = toClientError(error);
      if (clientError.code === 'AUTH_TOKEN_INVALID') {
        this.phase.set('invalid');
      } else if (clientError.code === 'AUTH_PASSWORD_REJECTED') {
        this.form.setServerError('password', 'Ce mot de passe est refusé : évite ton adresse e-mail et choisis une phrase plus longue.');
        focusFirstInvalid(this.host, this.injector);
      } else {
        this.serverError.set(clientError);
      }
    } finally {
      this.pending.set(false);
    }
  }
}
