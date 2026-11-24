import { ChangeDetectionStrategy, Component, ElementRef, computed, input, model, output, viewChild } from '@angular/core';

let nextId = 0;

/**
 * Saisie du code à 6 chiffres de l'application d'authentification : un seul champ (collage et remplissage
 * automatique iOS / Android via `autocomplete="one-time-code"`), clavier numérique, chiffres mono espacés,
 * 16 px minimum (pas de zoom iOS). Les caractères autres que des chiffres sont retirés à la saisie.
 * `complete` est émis dès que 6 chiffres sont saisis.
 */
@Component({
  selector: 'rj-otp-input',
  template: `
    <label [for]="id" class="text-body-sm font-medium text-ink">{{ label() }}</label>
    <input
      #field
      [id]="id"
      name="totp"
      type="text"
      inputmode="numeric"
      autocomplete="one-time-code"
      pattern="[0-9]*"
      maxlength="7"
      enterkeyhint="done"
      spellcheck="false"
      [value]="value()"
      [disabled]="disabled()"
      [attr.aria-invalid]="error() ? 'true' : null"
      [attr.aria-describedby]="error() ? errorId : hint() ? hintId : null"
      [class]="classes()"
      placeholder="000000"
      (input)="onInput($event)"
    />
    @if (error(); as error) {
      <p [id]="errorId" class="text-body-sm text-danger">{{ error }}</p>
    } @else if (hint(); as hint) {
      <p [id]="hintId" class="text-body-sm text-ink-muted">{{ hint }}</p>
    }
  `,
  host: { class: 'flex flex-col gap-2' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjOtpInput {
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  readonly value = model('');
  readonly label = input('Code à 6 chiffres');
  readonly hint = input('');
  readonly error = input('');
  readonly disabled = input(false);
  readonly complete = output<string>();

  protected readonly id = `rj-otp-${nextId++}`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly hintId = `${this.id}-hint`;
  protected readonly classes = computed(
    () =>
      'min-h-14 w-full rounded-md border bg-surface-raised px-4 text-center font-mono text-h2 tracking-widest text-ink tabular-nums ' +
      'placeholder:text-ink-muted/50 transition-colors duration-150 ease-raijin focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ' +
      'disabled:cursor-not-allowed disabled:opacity-60 ' +
      (this.error() ? 'border-danger' : 'border-line-strong hover:border-ink-muted'),
  );

  focus(): void {
    this.field().nativeElement.focus();
  }

  protected onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const digits = target.value.replace(/\D/g, '').slice(0, 6);
    if (target.value !== digits) target.value = digits;
    this.value.set(digits);
    if (digits.length === 6) this.complete.emit(digits);
  }
}
