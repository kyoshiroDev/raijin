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
import { PASSWORD_HINT, PASSWORD_RULES, registerRequestSchema } from '@raijin/shared-contracts';
import { AttributionTracker, AuthStore, safeRedirect, toClientError, type ClientError } from '@raijin/web-data-access';
import { RjButton, RjCheckbox, RjInputField, RjToastService } from '@raijin/web-ui';
import { RjAuthLayout } from '../shared/auth-layout';
import { RjEmailSent } from '../shared/email-sent';
import { focusFirstInvalid } from '../shared/focus';
import { RjFormAlert } from '../shared/form-alert';
import { DISCLAIMER, LEGAL_LINKS, TEXT_LINK } from '../shared/links';
import { zodForm } from '../shared/zod-form';

/**
 * Inscription : e-mail, mot de passe (règles NIST des contrats), acceptation explicite des CGU,
 * attribution de première visite jointe si elle existe. Réponse neutre (aucune énumération).
 */
@Component({
  selector: 'rj-register-page',
  imports: [RouterLink, RjAuthLayout, RjButton, RjCheckbox, RjInputField, RjFormAlert, RjEmailSent],
  template: `
    @if (sentTo(); as email) {
      <rj-auth-layout title="Vérifie ta boîte mail">
        <rj-email-sent
          [email]="email"
          detail="Clique sur le lien de confirmation pour activer ton compte. Il reste valable 24 heures."
          [sending]="resending()"
          (resend)="resend(email)"
        />
        <ng-container rjAuthFooter>
          <span>Déjà confirmé&nbsp;?</span>
          <a routerLink="/compte/connexion" [queryParams]="redirectParams()" [class]="link">Se connecter</a>
        </ng-container>
      </rj-auth-layout>
    } @else {
      <rj-auth-layout title="Créer ton compte" subtitle="Gratuit et sans carte bancaire. Tu confirmes ton adresse e-mail, et c’est parti.">
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
            enterkeyhint="next"
            [required]="true"
            [maxlength]="254"
            [value]="form.value().email"
            [error]="form.errors().email ?? ''"
            (valueChange)="form.set('email', $event)"
            (blurred)="form.touch('email')"
          />
          <rj-input-field
            label="Mot de passe"
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
          <rj-checkbox
            name="acceptTerms"
            [required]="true"
            [checked]="form.value().acceptTerms"
            [error]="form.errors().acceptTerms ?? ''"
            (checkedChange)="form.set('acceptTerms', $event)"
          >
            J’accepte les
            <a [href]="legal.terms" target="_blank" rel="noopener" class="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">conditions d’utilisation</a>
            et la
            <a [href]="legal.privacy" target="_blank" rel="noopener" class="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">politique de confidentialité</a>.
          </rj-checkbox>
          <button type="submit" rjButton="primary" size="lg" [block]="true" [loading]="pending()">Créer mon compte</button>
          <p class="text-label text-ink-muted">{{ disclaimer }}</p>
        </form>
        <ng-container rjAuthFooter>
          <span>Déjà un compte&nbsp;?</span>
          <a routerLink="/compte/connexion" [queryParams]="redirectParams()" [class]="link">Se connecter</a>
        </ng-container>
      </rj-auth-layout>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterPage {
  private readonly store = inject(AuthStore);
  private readonly attribution = inject(AttributionTracker);
  private readonly toasts = inject(RjToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);

  readonly redirect = input<string>();

  protected readonly link = TEXT_LINK;
  protected readonly legal = LEGAL_LINKS;
  protected readonly disclaimer = DISCLAIMER;
  protected readonly passwordHint = PASSWORD_HINT;
  protected readonly maxPassword = PASSWORD_RULES.maxLength;
  protected readonly form = zodForm(registerRequestSchema, { email: '', password: '', acceptTerms: false });
  protected readonly pending = signal(false);
  protected readonly resending = signal(false);
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
    this.pending.set(true);
    try {
      const attribution = await this.attribution.read();
      await this.store.register(attribution ? { ...body, attribution } : body);
      this.sentTo.set(body.email);
    } catch (error) {
      const clientError = toClientError(error);
      if (clientError.code === 'AUTH_PASSWORD_REJECTED') {
        this.form.setServerError('password', 'Ce mot de passe est refusé : évite ton adresse e-mail et choisis une phrase plus longue.');
        focusFirstInvalid(this.host, this.injector);
      } else {
        this.serverError.set(clientError);
      }
    } finally {
      this.pending.set(false);
    }
  }

  protected async resend(email: string): Promise<void> {
    this.resending.set(true);
    try {
      await this.store.resendVerification(email);
      this.toasts.show('E-mail renvoyé. Pense à regarder dans les indésirables.', { tone: 'success' });
    } catch (error) {
      this.toasts.show(toClientError(error).message, { tone: 'error' });
    } finally {
      this.resending.set(false);
    }
  }
}
