import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input } from '@angular/core';
import { RjIcon } from '../icon/icon';
import { type RjIconName } from '../icon/icons';

export type RjButtonVariant = 'primary' | 'secondary' | 'ghost';
export type RjButtonSize = 'md' | 'lg';

const BASE =
  'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-sans font-semibold ' +
  'transition-[background-color,border-color,box-shadow,color] duration-200 ease-raijin ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const VARIANTS: Record<RjButtonVariant, string> = {
  // Jaune thunder : UNE seule action principale par écran ; halo shadow-glow au survol et au focus.
  primary: 'bg-thunder text-on-thunder hover:shadow-glow focus-visible:shadow-glow',
  secondary: 'border border-line-strong bg-surface-raised text-ink hover:border-ink-muted',
  ghost: 'bg-transparent text-ink hover:bg-surface-raised',
};

const DISABLED = 'cursor-not-allowed border border-line bg-surface text-ink-muted shadow-none hover:shadow-none';

const SIZES: Record<RjButtonSize, string> = {
  md: 'min-h-11 min-w-11 px-4 text-body',
  lg: 'min-h-12 min-w-12 px-6 text-body',
};

/**
 * Bouton Raijin, sur `<button>` ou `<a>`. Cible tactile ≥ 44 px (48 px en `lg`).
 * `loading` désactive le bouton, annonce `aria-busy` et affiche un indicateur sobre.
 */
@Component({
  // Composant-attribut (comme Angular Material) : on garde la sémantique native de <button> et <a>.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'button[rjButton], a[rjButton]',
  imports: [RjIcon],
  template: `
    @if (loading()) {
      <rj-icon name="loader" [size]="20" [spin]="true" />
    } @else if (icon(); as icon) {
      <rj-icon [name]="icon" [size]="20" />
    }
    <span class="truncate"><ng-content /></span>
    @if (iconEnd(); as iconEnd) {
      <rj-icon [name]="iconEnd" [size]="20" />
    }
  `,
  host: {
    '[class]': 'classes()',
    '[attr.disabled]': 'isButton && inactive() ? "" : null',
    '[attr.aria-disabled]': 'inactive() ? "true" : null',
    '[attr.aria-busy]': 'loading() ? "true" : null',
    '[attr.tabindex]': '!isButton && inactive() ? "-1" : null',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjButton {
  readonly variant = input<RjButtonVariant>('secondary', { alias: 'rjButton' });
  readonly size = input<RjButtonSize>('md');
  readonly disabled = input(false);
  readonly loading = input(false);
  /** Pleine largeur (pratique sur mobile pour l'action collée en bas). */
  readonly block = input(false);
  readonly icon = input<RjIconName | null>(null);
  readonly iconEnd = input<RjIconName | null>(null);

  protected readonly isButton = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement.tagName === 'BUTTON';
  protected readonly inactive = computed(() => this.disabled() || this.loading());

  protected readonly classes = computed(() => {
    const variant = this.variant() || 'secondary';
    return [
      BASE,
      SIZES[this.size()],
      this.disabled() ? DISABLED : VARIANTS[variant],
      this.loading() ? 'cursor-progress' : '',
      this.block() ? 'w-full' : '',
    ].join(' ');
  });
}
