import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Bloc de chargement. La taille vient des classes de l'hôte (ex. `class="h-4 w-32"`).
 * Décoratif : le conteneur porte `aria-busy` et un libellé « Chargement… ».
 */
@Component({
  selector: 'rj-skeleton',
  template: '',
  host: {
    'aria-hidden': 'true',
    class: 'block animate-pulse bg-surface-raised',
    '[class.rounded-sm]': "shape() === 'line'",
    '[class.rounded-lg]': "shape() === 'block'",
    '[class.rounded-full]': "shape() === 'circle'",
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjSkeleton {
  readonly shape = input<'line' | 'block' | 'circle'>('line');
}
