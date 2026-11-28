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
import { Router, RouterLink } from '@angular/router';
import { loginRequestSchema } from '@raijin/shared-contracts';
import { AuthStore, safeRedirect, toClientError, type ClientError } from '@raijin/web-data-access';
import { RjButton, RjInputField } from '@raijin/web-ui';
import { RjAuthLayout } from '../shared/auth-layout';
import { focusFirstInvalid } from '../shared/focus';
import { RjFormAlert } from '../shared/form-alert';
import { TEXT_LINK } from '../shared/links';
import { zodForm } from '../shared/zod-form';

/** Connexion par e-mail et mot de passe, ou par lien magique. Retour vers `redirect` (validé). */
@Component({
  selector: 'rj-login-page',
  imports: [RouterLink, RjAuthLayout, RjButton, RjInputField, RjFormAlert],
  template: `
    <rj-auth-layout title="Connexion" subtitle="Content de te revoir. Connecte-toi pour retrouver tes suivis et tes alertes.">
      <form class="flex flex-col gap-4" novalidate (submit)="submit($event)">
        @if (serverError(); as error) {
          <rj-form-alert>
            {{ error.message }}
            @if (error.code === 'AUTH_EMAIL_NOT_VERIFIED') {
              <a routerLink="/compte/verifier-email" [class]="link">Renvoyer l’e-mail de confirmation</a>
            }
          </rj-form-alert>
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
        <div class="flex flex-col gap-1">
          <rj-input-field
            label="Mot de passe"
            name="password"
            type="password"
            autocomplete="current-password"
            enterkeyhint="go"
            [revealable]="true"
            [required]="true"
            [maxlength]="128"
            [value]="form.value().password"
            [error]="form.errors().password ?? ''"
            (valueChange)="form.set('password', $event)"
          />
          <a routerLink="/compte/mot-de-passe-oublie" [class]="link + ' self-end text-body-sm'">Mot de passe oublié&nbsp;?</a>
        </div>
        <button type="submit" rjButton="primary" size="lg" [block]="true" [loading]="pending()">Se connecter</button>
      </form>

      <div class="flex items-center gap-3 text-body-sm text-ink-muted" aria-hidden="true">
        <span class="h-px flex-1 bg-line"></span>ou<span class="h-px flex-1 bg-line"></span>
      </div>
      <a rjButton="secondary" icon="mail" [block]="true" routerLink="/compte/lien-magique" [queryParams]="redirectParams()">
        Recevoir un lien de connexion
      </a>

      <ng-container rjAuthFooter>
        <span>Pas encore de compte&nbsp;?</span>
        <a routerLink="/compte/inscription" [queryParams]="redirectParams()" [class]="link">Créer un compte</a>
      </ng-container>
    </rj-auth-layout>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {
  private readonly store = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);

  /** Paramètre `?redirect=` (lié par le routeur), validé avant tout usage. */
  readonly redirect = input<string>();

  protected readonly link = TEXT_LINK;
  protected readonly form = zodForm(loginRequestSchema, { email: '', password: '' });
  protected readonly pending = signal(false);
  protected readonly serverError = signal<ClientError | null>(null);
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
      await this.store.login(body);
      await this.router.navigateByUrl(safeRedirect(this.redirect()), { replaceUrl: true });
    } catch (error) {
      this.serverError.set(toClientError(error));
    } finally {
      this.pending.set(false);
    }
  }
}
