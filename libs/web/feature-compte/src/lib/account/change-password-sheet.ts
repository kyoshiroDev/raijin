import { ChangeDetectionStrategy, Component, ElementRef, Injector, inject, input, model, signal } from '@angular/core';
import { PASSWORD_HINT, PASSWORD_RULES, changePasswordRequestSchema } from '@raijin/shared-contracts';
import { AuthStore, toClientError, type ClientError } from '@raijin/web-data-access';
import { RjBottomSheet, RjButton, RjInputField, RjToastService } from '@raijin/web-ui';
import { focusFirstInvalid } from '../shared/focus';
import { RjFormAlert } from '../shared/form-alert';
import { zodForm } from '../shared/zod-form';

let nextId = 0;

/** Changement de mot de passe (bottom sheet sur mobile, modale dès 1024 px). Les autres sessions sont fermées. */
@Component({
  selector: 'rj-change-password-sheet',
  imports: [RjBottomSheet, RjButton, RjInputField, RjFormAlert],
  template: `
    <rj-bottom-sheet [(open)]="open" title="Changer le mot de passe" description="Tes autres appareils seront déconnectés.">
      <form [id]="formId" class="flex flex-col gap-4 pb-2" novalidate (submit)="submit($event)">
        <!-- Aide aux gestionnaires de mots de passe : identifiant associé au nouveau mot de passe. -->
        <input type="email" name="username" autocomplete="username" [value]="email()" class="sr-only" tabindex="-1" aria-hidden="true" readonly />
        @if (serverError(); as error) {
          <rj-form-alert>{{ error.message }}</rj-form-alert>
        }
        <rj-input-field
          label="Mot de passe actuel"
          name="current-password"
          type="password"
          autocomplete="current-password"
          enterkeyhint="next"
          [revealable]="true"
          [required]="true"
          [maxlength]="maxPassword"
          [value]="form.value().currentPassword"
          [error]="form.errors().currentPassword ?? ''"
          (valueChange)="form.set('currentPassword', $event)"
        />
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
          [value]="form.value().newPassword"
          [error]="form.errors().newPassword ?? ''"
          (valueChange)="form.set('newPassword', $event)"
          (blurred)="form.touch('newPassword')"
        />
      </form>
      <ng-container rjSheetFooter>
        <button type="button" rjButton="ghost" (click)="open.set(false)">Annuler</button>
        <button type="submit" [attr.form]="formId" rjButton="primary" [loading]="pending()">Enregistrer</button>
      </ng-container>
    </rj-bottom-sheet>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjChangePasswordSheet {
  private readonly store = inject(AuthStore);
  private readonly toasts = inject(RjToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);

  readonly open = model(false);
  readonly email = input('');

  protected readonly formId = `rj-change-password-${nextId++}`;
  protected readonly passwordHint = PASSWORD_HINT;
  protected readonly maxPassword = PASSWORD_RULES.maxLength;
  protected readonly form = zodForm(changePasswordRequestSchema, { currentPassword: '', newPassword: '' });
  protected readonly pending = signal(false);
  protected readonly serverError = signal<ClientError | null>(null);

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
      await this.store.changePassword(body);
      this.form.reset();
      this.open.set(false);
      this.toasts.show('Mot de passe modifié. Tes autres appareils sont déconnectés.', { tone: 'success' });
    } catch (error) {
      const clientError = toClientError(error);
      if (clientError.code === 'AUTH_INVALID_CREDENTIALS') {
        this.form.setServerError('currentPassword', 'Mot de passe actuel incorrect.');
        focusFirstInvalid(this.host, this.injector);
      } else if (clientError.code === 'AUTH_PASSWORD_REJECTED') {
        this.form.setServerError('newPassword', 'Ce mot de passe est refusé : évite ton adresse e-mail et choisis une phrase plus longue.');
        focusFirstInvalid(this.host, this.injector);
      } else {
        this.serverError.set(clientError);
      }
    } finally {
      this.pending.set(false);
    }
  }
}
