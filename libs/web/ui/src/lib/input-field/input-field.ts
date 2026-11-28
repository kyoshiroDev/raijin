import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RjClipboard } from '../clipboard/clipboard';
import { RjIcon } from '../icon/icon';

let nextId = 0;

/** Longueur max par défaut : assez pour une adresse ou un lien DexScreener / pump.fun / Solscan. */
export const RJ_INPUT_MAX_LENGTH = 256;

/**
 * Champ de saisie Raijin : 16 px minimum (pas de zoom iOS), 48 px de haut, `inputmode` et
 * `autocomplete` réglables. Avec `pasteable`, un bouton « Coller » lit le presse-papiers ;
 * si l'accès est refusé, un message explique le collage manuel et le champ reçoit le focus.
 */
@Component({
  selector: 'rj-input-field',
  imports: [RjIcon],
  template: `
    <label [for]="inputId" class="text-body-sm font-medium text-ink">{{ label() }}</label>
    <div class="flex gap-2">
      <div class="relative flex min-w-0 flex-1">
      <input
        #field
        [id]="inputId"
        [attr.name]="name()"
        [type]="effectiveType()"
        [attr.inputmode]="inputmode()"
        [attr.autocomplete]="autocomplete()"
        [attr.enterkeyhint]="enterkeyhint()"
        [attr.placeholder]="placeholder() || null"
        [attr.maxlength]="maxlength()"
        [attr.aria-invalid]="error() ? 'true' : null"
        [attr.required]="required() ? '' : null"
        [attr.aria-required]="required() ? 'true' : null"
        [attr.aria-describedby]="describedBy()"
        [disabled]="disabled()"
        [value]="value()"
        (input)="onInput($event)"
        autocapitalize="off"
        spellcheck="false"
        class="min-h-12 w-full min-w-0 flex-1 rounded-md border bg-surface px-3 text-input text-ink placeholder:font-sans placeholder:text-ink-muted transition-colors duration-150 ease-raijin hover:border-ink-muted focus-visible:border-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-60"
        [class.font-mono]="mono()"
        [class.pr-14]="revealable()"
        [class.border-line-strong]="!error()"
        [class.border-danger]="!!error()"
        (blur)="blurred.emit()"
      />
      @if (revealable()) {
        <button
          type="button"
          class="absolute inset-y-0.5 right-0.5 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 ease-raijin hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed"
          [disabled]="disabled()"
          [attr.aria-label]="revealed() ? 'Masquer le mot de passe' : 'Afficher le mot de passe'"
          [attr.aria-pressed]="revealed()"
          [attr.aria-controls]="inputId"
          (click)="toggleReveal()"
        >
          <rj-icon [name]="revealed() ? 'eyeOff' : 'eye'" [size]="20" />
        </button>
      }
      </div>
      @if (pasteable()) {
        <button
          type="button"
          class="inline-flex min-h-12 min-w-12 shrink-0 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface-raised px-3 text-body font-semibold text-ink transition-colors duration-200 ease-raijin hover:border-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-60"
          [disabled]="disabled()"
          [attr.aria-label]="'Coller dans le champ ' + label()"
          (click)="paste()"
        >
          <rj-icon name="paste" [size]="20" />
          <span class="hidden xs:inline">Coller</span>
        </button>
      }
    </div>
    @if (error(); as error) {
      <p [id]="messageId" class="flex items-start gap-1.5 text-body-sm text-danger">
        <rj-icon name="circleAlert" [size]="16" class="mt-0.5" />
        <span>{{ error }}</span>
      </p>
    } @else if (pasteRefused()) {
      <p [id]="messageId" role="status" class="flex items-start gap-1.5 text-body-sm text-ink-muted">
        <rj-icon name="info" [size]="16" class="mt-0.5" />
        <span>Accès au presse-papiers refusé&nbsp;: maintiens le doigt dans le champ puis choisis «&nbsp;Coller&nbsp;».</span>
      </p>
    } @else if (hint(); as hint) {
      <p [id]="messageId" class="text-body-sm text-ink-muted">{{ hint }}</p>
    }
  `,
  host: { class: 'flex min-w-0 flex-col gap-2' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjInputField {
  private readonly clipboard = inject(RjClipboard);
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  readonly label = input.required<string>();
  readonly value = model('');
  readonly placeholder = input('');
  readonly hint = input('');
  readonly error = input('');
  readonly name = input<string | null>(null);
  readonly type = input<'text' | 'search' | 'email' | 'url' | 'password'>('text');
  readonly inputmode = input<'text' | 'search' | 'email' | 'url' | 'numeric' | 'decimal'>('text');
  readonly autocomplete = input('off');
  readonly enterkeyhint = input<'search' | 'go' | 'done' | 'next' | 'send' | null>(null);
  readonly mono = input(false);
  readonly pasteable = input(false);
  readonly disabled = input(false);
  readonly required = input(false);
  /** Avec `type="password"` : bouton « Afficher / Masquer le mot de passe » dans le champ. */
  readonly revealable = input(false);
  /** Limite de saisie, appliquée aussi au texte collé (le presse-papiers n'est pas une source sûre). */
  readonly maxlength = input(RJ_INPUT_MAX_LENGTH);

  readonly pasted = output<string>();
  readonly pasteFailed = output<void>();
  readonly blurred = output<void>();

  protected readonly inputId = `rj-field-${nextId++}`;
  protected readonly messageId = `${this.inputId}-message`;
  protected readonly pasteRefused = signal(false);
  protected readonly revealed = signal(false);
  protected readonly effectiveType = computed(() =>
    this.type() === 'password' && this.revealed() ? 'text' : this.type(),
  );
  protected readonly describedBy = computed(() =>
    this.error() || this.pasteRefused() || this.hint() ? this.messageId : null,
  );

  protected onInput(event: Event): void {
    this.pasteRefused.set(false);
    this.value.set((event.target as HTMLInputElement).value);
  }

  protected toggleReveal(): void {
    this.revealed.update((value) => !value);
  }

  async paste(): Promise<void> {
    const text = await this.clipboard.read();
    if (text === null) {
      this.pasteRefused.set(true);
      this.pasteFailed.emit();
      this.field().nativeElement.focus();
      return;
    }
    const clean = text.trim().slice(0, this.maxlength());
    this.pasteRefused.set(false);
    this.value.set(clean);
    this.pasted.emit(clean);
  }

  focus(): void {
    this.field().nativeElement.focus();
  }
}
