import { ChangeDetectionStrategy, Component, ElementRef, Injector, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forgotPasswordRequestSchema } from '@raijin/shared-contracts';
import { AuthStore, toClientError, type ClientError } from '@raijin/web-data-access';
import { RjButton, RjInputField, RjToastService } from '@raijin/web-ui';
import { RjAuthLayout } from '../shared/auth-layout';
import { RjEmailSent } from '../shared/email-sent';
import { focusFirstInvalid, focusPageTitle } from '../shared/focus';
import { RjFormAlert } from '../shared/form-alert';
import { TEXT_LINK } from '../shared/links';
import { zodForm } from '../shared/zod-form';

/** Mot de passe oublié : envoi d'un lien de réinitialisation (30 minutes). Réponse neutre. */
@Component({
  selector: 'rj-forgot-password-page',
  imports: [RouterLink, RjAuthLayout, RjButton, RjInputField, RjFormAlert, RjEmailSent],
  template: `
    @if (sentTo(); as email) {
      <rj-auth-layout title="Vérifie ta boîte mail">
        <rj-email-sent
          [email]="email"
          detail="Le lien pour choisir un nouveau mot de passe reste valable 30 minutes."
          [sending]="pending()"
          (resend)="resend(email)"
        />
        <ng-container rjAuthFooter>
          <a routerLink="/compte/connexion" [class]="link">Retour à la connexion</a>
        </ng-container>
      </rj-auth-layout>
    } @else {
      <rj-auth-layout title="Mot de passe oublié" subtitle="Indique ton adresse e-mail : tu vas recevoir un lien pour choisir un nouveau mot de passe.">
        <form class="flex flex-col gap-4" novalidate (submit)="submit($event)">
          @if (serverError(); as error) {
            <rj-form-alert>{{ error.message }}</rj-form-alert>
          }
          <rj-input-field
            label="Adresse e-mail"
            name="email"
            type="email"
            inputmode="email"
            autocomplete="email"
            enterkeyhint="send"
            [required]="true"
            [maxlength]="254"
            [value]="form.value().email"
            [error]="form.errors().email ?? ''"
            (valueChange)="form.set('email', $event)"
            (blurred)="form.touch('email')"
          />
          <button type="submit" rjButton="primary" size="lg" [block]="true" [loading]="pending()">Envoyer le lien</button>
        </form>
        <ng-container rjAuthFooter>
          <a routerLink="/compte/connexion" [class]="link">Retour à la connexion</a>
        </ng-container>
      </rj-auth-layout>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForgotPasswordPage {
  private readonly store = inject(AuthStore);
  private readonly toasts = inject(RjToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);

  protected readonly link = TEXT_LINK;
  protected readonly form = zodForm(forgotPasswordRequestSchema, { email: '' });
  protected readonly pending = signal(false);
  protected readonly serverError = signal<ClientError | null>(null);
  protected readonly sentTo = signal<string | null>(null);

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.pending()) return;
    this.serverError.set(null);
    const body = this.form.submit();
    if (!body) {
      focusFirstInvalid(this.host, this.injector);
      return;
    }
    this.pending.set(true);
    try {
      await this.store.forgotPassword(body);
      this.sentTo.set(body.email);
      focusPageTitle(this.host, this.injector);
    } catch (error) {
      this.serverError.set(toClientError(error));
    } finally {
      this.pending.set(false);
    }
  }

  protected async resend(email: string): Promise<void> {
    this.pending.set(true);
    try {
      await this.store.forgotPassword({ email });
      this.toasts.show('Nouveau lien envoyé. Seul le dernier reçu fonctionne.', { tone: 'success' });
    } catch (error) {
      this.toasts.show(toClientError(error).message, { tone: 'error' });
    } finally {
      this.pending.set(false);
    }
  }
}
