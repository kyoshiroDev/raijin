import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { magicLinkRequestSchema } from '@raijin/shared-contracts';
import { AuthStore, safeRedirect, toClientError, type ClientError } from '@raijin/web-data-access';
import { RjButton, RjInputField, RjToastService } from '@raijin/web-ui';
import { RjAuthLayout } from '../shared/auth-layout';
import { RjEmailSent } from '../shared/email-sent';
import { focusFirstInvalid } from '../shared/focus';
import { RjFormAlert } from '../shared/form-alert';
import { TEXT_LINK } from '../shared/links';
import { zodForm } from '../shared/zod-form';

/** Demande d'un lien de connexion à usage unique (15 minutes). Réponse neutre. */
@Component({
  selector: 'rj-magic-link-page',
  imports: [RouterLink, RjAuthLayout, RjButton, RjInputField, RjFormAlert, RjEmailSent],
  template: `
    @if (sentTo(); as email) {
      <rj-auth-layout title="Vérifie ta boîte mail">
        <rj-email-sent
          [email]="email"
          detail="Ouvre le lien sur cet appareil pour te connecter. Il reste valable 15 minutes et ne sert qu’une fois."
          [sending]="pending()"
          (resend)="send(email)"
        />
        <ng-container rjAuthFooter>
          <a routerLink="/compte/connexion" [queryParams]="redirectParams()" [class]="link">Se connecter avec un mot de passe</a>
        </ng-container>
      </rj-auth-layout>
    } @else {
      <rj-auth-layout title="Connexion sans mot de passe" subtitle="Reçois un lien de connexion par e-mail. Un clic et tu es connecté.">
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
          <button type="submit" rjButton="primary" size="lg" icon="mail" [block]="true" [loading]="pending()">Recevoir le lien</button>
        </form>
        <ng-container rjAuthFooter>
          <a routerLink="/compte/connexion" [queryParams]="redirectParams()" [class]="link">Se connecter avec un mot de passe</a>
        </ng-container>
      </rj-auth-layout>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MagicLinkPage {
  private readonly store = inject(AuthStore);
  private readonly toasts = inject(RjToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);

  readonly redirect = input<string>();

  protected readonly link = TEXT_LINK;
  protected readonly form = zodForm(magicLinkRequestSchema, { email: '' });
  protected readonly pending = signal(false);
  protected readonly serverError = signal<ClientError | null>(null);
  protected readonly sentTo = signal<string | null>(null);
  protected readonly redirectParams = computed(() => {
    const target = this.redirect();
    return target ? { redirect: safeRedirect(target) } : {};
  });

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.pending()) return;
    this.serverError.set(null);
    const body = this.form.submit();
    if (!body) {
      focusFirstInvalid(this.host, this.injector);
      return;
    }
    try {
      await this.send(body.email);
      this.sentTo.set(body.email);
    } catch (error) {
      this.serverError.set(toClientError(error));
    }
  }

  /** Envoi (premier ou renvoi). `redirectPath` n'est transmis que s'il est valide. */
  protected async send(email: string, fromResend = this.sentTo() !== null): Promise<void> {
    const target = this.redirect();
    this.pending.set(true);
    try {
      await this.store.requestMagicLink(target ? { email, redirectPath: safeRedirect(target) } : { email });
      if (fromResend) this.toasts.show('Nouveau lien envoyé. Seul le dernier reçu fonctionne.', { tone: 'success' });
    } catch (error) {
      if (!fromResend) throw error;
      this.toasts.show(toClientError(error).message, { tone: 'error' });
    } finally {
      this.pending.set(false);
    }
  }
}
