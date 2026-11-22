import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

let nextId = 0;

/**
 * Interrupteur (préférences) : `button role="switch"` (clavier, lecteurs d'écran), libellé et
 * description cliquables sur toute la ligne (cible ≥ 44 px). L'état est aussi écrit en toutes
 * lettres (« Activé » / « Désactivé ») : jamais la couleur seule. Pas de jaune : il reste réservé
 * à l'action principale de l'écran.
 */
@Component({
  selector: 'rj-switch',
  template: `
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <label [for]="id" class="cursor-pointer text-body font-medium text-ink" [class.cursor-not-allowed]="disabled()">{{ label() }}</label>
      @if (description(); as description) {
        <p [id]="descriptionId" class="text-body-sm text-ink-muted">{{ description }}</p>
      }
    </div>
    <button
      type="button"
      role="switch"
      [id]="id"
      [attr.aria-checked]="checked()"
      [attr.aria-describedby]="description() ? descriptionId : null"
      [disabled]="disabled()"
      [attr.aria-busy]="busy() ? 'true' : null"
      class="group inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed"
      (click)="toggle()"
    >
      <span class="hidden w-20 text-right text-body-sm text-ink-muted sm:inline" aria-hidden="true">{{ stateLabel() }}</span>
      <span [class]="trackClasses()" aria-hidden="true">
        <span [class]="thumbClasses()"></span>
      </span>
    </button>
  `,
  host: { class: 'flex items-center gap-4 py-3' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjSwitch {
  /**
   * Composant contrôlé : l'état affiché est toujours celui du parent (`[checked]`), qui le met à
   * jour sur `(checkedChange)`. Un enregistrement refusé revient ainsi sans désynchronisation.
   */
  readonly checked = input(false);
  readonly checkedChange = output<boolean>();
  readonly label = input.required<string>();
  readonly description = input('');
  readonly disabled = input(false);
  /** Enregistrement en cours (l'interrupteur reste lisible, annoncé occupé). */
  readonly busy = input(false);

  protected readonly id = `rj-switch-${nextId++}`;
  protected readonly descriptionId = `${this.id}-desc`;
  protected readonly stateLabel = computed(() => (this.checked() ? 'Activé' : 'Désactivé'));
  protected readonly trackClasses = computed(() =>
    [
      'relative inline-flex h-7 w-12 items-center rounded-full border transition-colors duration-200 ease-raijin',
      this.disabled()
        ? 'border-line bg-surface'
        : this.checked()
          ? 'border-ink bg-ink'
          : 'border-line-strong bg-surface-raised group-hover:border-ink-muted',
    ].join(' '),
  );
  protected readonly thumbClasses = computed(() =>
    [
      'inline-block size-5 rounded-full transition-transform duration-200 ease-raijin',
      this.checked() ? 'translate-x-6' : 'translate-x-1',
      this.disabled() ? 'bg-line' : this.checked() ? 'bg-base' : 'bg-ink-muted',
    ].join(' '),
  );

  protected toggle(): void {
    if (!this.disabled() && !this.busy()) this.checkedChange.emit(!this.checked());
  }
}
