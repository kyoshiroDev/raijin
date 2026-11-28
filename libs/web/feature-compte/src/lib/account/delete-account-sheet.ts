import { ChangeDetectionStrategy, Component, ElementRef, Injector, inject, input, model, output, signal } from '@angular/core';
import { PASSWORD_RULES, deleteAccountRequestSchema } from '@raijin/shared-contracts';
import { AuthStore, toClientError, type ClientError } from '@raijin/web-data-access';
import { RjBottomSheet, RjButton, RjInputField } from '@raijin/web-ui';
import { focusFirstInvalid } from '../shared/focus';
import { RjFormAlert } from '../shared/form-alert';
import { zodForm } from '../shared/zod-form';

let nextId = 0;

/**
 * Suppression définitive du compte, en bottom sheet (modale dès 1024 px). Confirmée par le mot de
 * passe actuel (`DeleteAccountRequest`, exigé par l'API) : un toucher par erreur ne suffit pas.
 */
@Component({
  selector: 'rj-delete-account-sheet',
  imports: [RjBottomSheet, RjButton, RjInputField, RjFormAlert],
  template: `
    <rj-bottom-sheet [(open)]="open" title="Supprimer ton compte" description="Cette action est définitive.">
      <form [id]="formId" class="flex flex-col gap-4 pb-2" novalidate (submit)="confirm($event)">
        <input type="email" name="username" autocomplete="username" [value]="email()" class="sr-only" tabindex="-1" aria-hidden="true" readonly />
        <ul class="flex list-disc flex-col gap-1 pl-5 text-body text-ink-muted">
          <li>Tes suivis, alertes et préférences sont effacés.</li>
          <li>Tes sessions sont fermées sur tous tes appareils.</li>
          <li>Exporte tes données avant si tu veux les garder.</li>
        </ul>
        @if (serverError(); as error) {
          <rj-form-alert>{{ error.message }}</rj-form-alert>
        }
        <rj-input-field
          label="Ton mot de passe, pour confirmer"
          name="current-password"
          type="password"
          autocomplete="current-password"
          enterkeyhint="done"
          [revealable]="true"
          [required]="true"
          [maxlength]="maxPassword"
          [value]="form.value().password"
          [error]="form.errors().password ?? ''"
          (valueChange)="form.set('password', $event)"
        />
      </form>
      <ng-container rjSheetFooter>
        <button type="button" rjButton="ghost" (click)="open.set(false)">Annuler</button>
        <button type="submit" [attr.form]="formId" rjButton="danger" icon="trash" [disabled]="!form.valid()" [loading]="pending()">
          Supprimer définitivement
        </button>
      </ng-container>
    </rj-bottom-sheet>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjDeleteAccountSheet {
  private readonly store = inject(AuthStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);

  readonly open = model(false);
  readonly email = input('');
  readonly deleted = output<void>();

  protected readonly formId = `rj-delete-account-${nextId++}`;
  protected readonly maxPassword = PASSWORD_RULES.maxLength;
  protected readonly form = zodForm(deleteAccountRequestSchema, { password: '' });
  protected readonly pending = signal(false);
  protected readonly serverError = signal<ClientError | null>(null);

  protected async confirm(event: Event): Promise<void> {
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
      await this.store.deleteAccount(body);
      this.form.reset();
      this.open.set(false);
      this.deleted.emit();
    } catch (error) {
      const clientError = toClientError(error);
      if (clientError.code === 'AUTH_INVALID_CREDENTIALS') {
        this.form.setServerError('password', 'Mot de passe incorrect.');
        focusFirstInvalid(this.host, this.injector);
      } else {
        this.serverError.set(clientError);
      }
    } finally {
      this.pending.set(false);
    }
  }
}
