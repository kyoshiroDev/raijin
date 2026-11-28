import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Carte : `rounded-lg`, padding 16 px (24 px dès md), pleine hauteur de sa cellule de grille.
 * Le contenu est en colonne ; le pied (`[rjCardFooter]`) est poussé en bas pour aligner
 * les cartes d'une même grille.
 */
@Component({
  selector: 'rj-card',
  template: `
    <div class="flex min-w-0 flex-1 flex-col gap-3">
      <ng-content />
    </div>
    <div class="mt-auto empty:hidden"><ng-content select="[rjCardFooter]" /></div>
  `,
  host: { '[class]': 'classes()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjCard {
  /** `raised` : un cran de profondeur au-dessus (surface-raised), au lieu d'une ombre. */
  readonly tone = input<'surface' | 'raised'>('surface');
  /** Retour visuel de survol quand la carte entière est cliquable. */
  readonly interactive = input(false);

  protected readonly classes = computed(() =>
    [
      'flex h-full min-w-0 flex-col gap-4 rounded-lg border border-line p-4 md:p-6',
      this.tone() === 'raised' ? 'bg-surface-raised' : 'bg-surface',
      this.interactive()
        ? 'transition-colors duration-200 ease-raijin hover:border-ink-muted focus-within:border-ink-muted'
        : '',
    ].join(' '),
  );
}
