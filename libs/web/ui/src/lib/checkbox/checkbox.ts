import { ChangeDetectionStrategy, Component, ElementRef, input, model, viewChild } from '@angular/core';
import { RjIcon } from '../icon/icon';

let nextId = 0;

/**
 * Case à cocher Raijin : case native (lecteurs d'écran, clavier), libellé projeté et cliquable
 * sur toute sa hauteur (cible ≥ 44 px), message d'erreur relié par `aria-describedby`.
 */
@Component({
  selector: 'rj-checkbox',
  imports: [RjIcon],
  template: `
    <label [for]="inputId" class="flex min-h-11 cursor-pointer items-start gap-3 py-2.5 text-body text-ink">
      <input
        #box
        type="checkbox"
        [id]="inputId"
        [attr.name]="name()"
        [checked]="checked()"
        [disabled]="disabled()"
        [attr.required]="required() ? '' : null"
        [attr.aria-invalid]="error() ? 'true' : null"
        [attr.aria-describedby]="error() ? messageId : null"
        (change)="checked.set(box.checked)"
        class="mt-0.5 size-5 shrink-0 cursor-pointer accent-thunder focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed"
      />
      <span class="min-w-0"><ng-content /></span>
    </label>
    @if (error(); as error) {
      <p [id]="messageId" class="flex items-start gap-1.5 pl-8 text-body-sm text-danger">
        <rj-icon name="circleAlert" [size]="16" class="mt-0.5" />
        <span>{{ error }}</span>
      </p>
    }
  `,
  host: { class: 'flex flex-col gap-1' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjCheckbox {
  private readonly box = viewChild.required<ElementRef<HTMLInputElement>>('box');

  readonly checked = model(false);
  readonly name = input<string | null>(null);
  readonly error = input('');
  readonly disabled = input(false);
  readonly required = input(false);

  protected readonly inputId = `rj-checkbox-${nextId++}`;
  protected readonly messageId = `${this.inputId}-message`;

  focus(): void {
    this.box().nativeElement.focus();
  }
}
