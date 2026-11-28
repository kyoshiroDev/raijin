import { ChangeDetectionStrategy, Component, input, model, signal } from '@angular/core';
import { Icon } from '../../../shared/ui/icon';

/** Password input with an accessible show/hide toggle. */
@Component({
  selector: 'app-password-field',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label [for]="fieldId()" class="text-sm text-muted">{{ label() }}</label>
    <div class="relative mt-1">
      <input
        class="field pr-12"
        [id]="fieldId()"
        [name]="fieldId()"
        [type]="visible() ? 'text' : 'password'"
        [attr.autocomplete]="autocomplete()"
        [attr.maxlength]="maxLength()"
        [attr.aria-invalid]="invalid() ? 'true' : null"
        [attr.aria-describedby]="describedBy()"
        autocapitalize="off"
        spellcheck="false"
        required
        [value]="value()"
        (input)="onInput($event)"
      />
      <button
        type="button"
        class="absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center rounded-xl text-muted hover:text-fg"
        [attr.aria-label]="visible() ? 'Masquer le mot de passe' : 'Afficher le mot de passe'"
        [attr.aria-pressed]="visible()"
        [attr.aria-controls]="fieldId()"
        (click)="visible.set(!visible())"
      >
        <app-icon [name]="visible() ? 'eye-off' : 'eye'" class="size-5" />
      </button>
    </div>
  `,
})
export class PasswordField {
  readonly fieldId = input.required<string>();
  readonly label = input.required<string>();
  readonly autocomplete = input<'current-password' | 'new-password'>('current-password');
  readonly maxLength = input<number | null>(null);
  readonly invalid = input(false);
  readonly describedBy = input<string | null>(null);
  readonly value = model('');

  readonly visible = signal(false);

  onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }
}
