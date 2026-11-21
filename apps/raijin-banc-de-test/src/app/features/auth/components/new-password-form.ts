import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { evaluatePassword, isPasswordAcceptable, isPasswordTooLong, PASSWORD_MAX_BYTES } from '../password-rules';
import { PasswordChecklist } from './password-checklist';
import { PasswordField } from './password-field';

/**
 * New password + confirmation with a live rules checklist. Emits the password once valid.
 * Extra fields (e.g. the current password) can be projected at the top of the form; the
 * parent then gates submission with `canSave`.
 */
@Component({
  selector: 'app-new-password-form',
  imports: [PasswordField, PasswordChecklist],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="mt-8 space-y-4" (submit)="submit($event)">
      <ng-content />
      <app-password-field
        fieldId="new-password"
        label="Nouveau mot de passe"
        autocomplete="new-password"
        describedBy="password-rules"
        [maxLength]="maxLength"
        [invalid]="tooLong()"
        [(value)]="password"
      />
      <app-password-field
        fieldId="confirm-password"
        label="Confirmation"
        autocomplete="new-password"
        [maxLength]="maxLength"
        [invalid]="mismatch()"
        [(value)]="confirmation"
      />
      <app-password-checklist id="password-rules" [rules]="rules()" />
      @if (tooLong()) {
        <p class="text-sm text-bear" role="alert">
          Trop long : {{ maxLength }} octets maximum (une lettre accentuée compte pour 2).
        </p>
      }
      @if (error(); as message) {
        <p class="text-sm text-bear" role="alert">{{ message }}</p>
      }
      <button type="submit" class="btn-primary w-full" [disabled]="!canSubmit()">
        {{ pending() ? 'Enregistrement…' : 'Enregistrer le mot de passe' }}
      </button>
    </form>
  `,
})
export class NewPasswordForm {
  readonly pending = input(false);
  readonly error = input<string | null>(null);
  /** Extra precondition from the parent (e.g. current password filled, not locked). */
  readonly canSave = input(true);
  readonly save = output<string>();

  /** Byte limit; also a safe `maxlength` (UTF-16 units ≤ UTF-8 bytes), the rules do the exact check. */
  protected readonly maxLength = PASSWORD_MAX_BYTES;

  readonly password = signal('');
  readonly confirmation = signal('');
  readonly rules = computed(() => evaluatePassword(this.password(), this.confirmation()));
  readonly tooLong = computed(() => isPasswordTooLong(this.password()));
  readonly mismatch = computed(() => this.confirmation().length > 0 && this.password() !== this.confirmation());
  readonly canSubmit = computed(
    () => !this.pending() && this.canSave() && isPasswordAcceptable(this.password(), this.confirmation()),
  );

  submit(event: Event): void {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.save.emit(this.password());
  }
}
