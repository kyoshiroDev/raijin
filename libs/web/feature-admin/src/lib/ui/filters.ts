import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RjBottomSheet, RjButton, desktopViewport } from '@raijin/web-ui';

/**
 * Filtres d’un écran admin (dimension, fenêtre, recherche…) : en ligne dès 1024 px, alignés en haut (une aide
 * sous un champ ne décale pas les autres) ; en dessous, un bouton
 * « Filtres » ouvre un bottom sheet avec le même contenu (appliqué en direct, bouton « Voir les résultats »
 * pour refermer). Le sélecteur de période reste hors des filtres, toujours visible.
 *
 * `<rj-admin-filters [activeCount]="filtresActifs()"> <label>…</label> <select>…</select> </rj-admin-filters>`
 */
@Component({
  selector: 'rj-admin-filters',
  imports: [NgTemplateOutlet, RjBottomSheet, RjButton],
  template: `
    <ng-template #content><ng-content /></ng-template>
    @if (desktop() !== false) {
      <div class="hidden flex-wrap items-start gap-3 lg:flex" data-rj-filters-row>
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

  protected readonly desktop = desktopViewport();
  protected readonly open = signal(false);
  protected readonly buttonLabel = computed(() => (this.activeCount() > 0 ? `Filtres (${this.activeCount()})` : 'Filtres'));
}
