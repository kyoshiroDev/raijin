import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RjBottomSheet, RjButton, desktopViewport } from '@raijin/web-ui';

/**
 * Filtres d’un écran admin (dimension, fenêtre, recherche…) : en ligne dès 1024 px, alignés en haut (une aide
 * sous un champ ne décale pas les autres) ; en dessous, un bouton
 * « Filtres » ouvre un bottom sheet avec le même contenu (appliqué en direct, bouton « Voir les résultats »
 * pour refermer). Le sélecteur de période reste hors des filtres, toujours visible.
 *
 * `layout="grid"` : la rangée occupe toute la largeur (colonnes égales `auto-fit`, au moins 10rem), pour les écrans
 * à nombreux filtres ; `inline` (défaut) : champs à leur largeur, à la suite.
 *
 * `<rj-admin-filters [activeCount]="filtresActifs()"> <label>…</label> <select>…</select> </rj-admin-filters>`
 */
@Component({
  selector: 'rj-admin-filters',
  imports: [NgTemplateOutlet, RjBottomSheet, RjButton],
  template: `
    <ng-template #content><ng-content /></ng-template>
    @if (desktop() !== false) {
      <div [class]="rowClass()" data-rj-filters-row [attr.data-rj-filters-layout]="layout()">
        <ng-container *ngTemplateOutlet="content" />
      </div>
    }
    @if (desktop() !== true) {
      <button type="button" rjButton="secondary" icon="filter" class="lg:hidden" [attr.aria-haspopup]="'dialog'" (click)="open.set(true)">
        {{ buttonLabel() }}
      </button>
      <rj-bottom-sheet [(open)]="open" [title]="title()" [description]="description()">
        <div class="flex flex-col gap-4 pb-2">
          <ng-container *ngTemplateOutlet="content" />
        </div>
        <button rjSheetFooter type="button" rjButton="secondary" [block]="true" (click)="open.set(false)">Voir les résultats</button>
      </rj-bottom-sheet>
    }
  `,
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAdminFilters {
  readonly title = input('Filtres');
  readonly description = input('');
  /** Nombre de filtres différents de la valeur par défaut, affiché dans le bouton mobile. */
  readonly activeCount = input(0);
  /** `inline` : champs à leur largeur ; `grid` : grille pleine largeur à colonnes égales. */
  readonly layout = input<'inline' | 'grid'>('inline');

  protected readonly desktop = desktopViewport();
  protected readonly open = signal(false);
  protected readonly rowClass = computed(() =>
    this.layout() === 'grid'
      ? 'hidden w-full grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] items-start gap-3 lg:grid'
      : 'hidden flex-wrap items-start gap-3 lg:flex',
  );
  protected readonly buttonLabel = computed(() => (this.activeCount() > 0 ? `Filtres (${this.activeCount()})` : 'Filtres'));
}
