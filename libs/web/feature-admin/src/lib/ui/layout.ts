import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RjSkeleton } from '@raijin/web-ui';

/**
 * Grille de KPI : 2 colonnes sur mobile, 3 dès 768 px, 4 dès 1280 px (5 avec `[wide]="true"`, pour les 10 KPI
 * de la vue d'ensemble). Lignes de même hauteur : les cartes restent alignées.
 *
 * `<rj-kpi-grid> @for (kpi of kpis; track kpi.key) { <rj-kpi-card [kpi]="kpi" /> } </rj-kpi-grid>`
 */
@Component({
  selector: 'rj-kpi-grid',
  template: `<ng-content />`,
  host: { '[class]': 'classes()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjKpiGrid {
  readonly wide = input(false);
  protected readonly classes = computed(
    () => `grid auto-rows-fr grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 ${this.wide() ? 'xl:grid-cols-5' : 'xl:grid-cols-4'}`,
  );
}

/**
 * Bloc de contenu d'un écran admin (graphique, tableau) : titre `h2`, description et actions facultatives,
 * pied (`[rjPanelFooter]`) poussé en bas pour aligner les panneaux d'une même grille.
 *
 * `<rj-admin-panel title="Inscriptions" description="Par jour, avec la période précédente">…</rj-admin-panel>`
 * Actions à droite du titre : `<div rjPanelActions>…</div>`.
 */
@Component({
  selector: 'rj-admin-panel',
  template: `
    <header class="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 class="font-display text-h3 text-ink">{{ title() }}</h2>
        @if (description(); as description) {
          <p class="text-body-sm text-ink-muted">{{ description }}</p>
        }
      </div>
      <div class="flex shrink-0 items-center gap-2 empty:hidden"><ng-content select="[rjPanelActions]" /></div>
    </header>
    <div class="flex min-w-0 flex-1 flex-col gap-4"><ng-content /></div>
    <div class="empty:hidden"><ng-content select="[rjPanelFooter]" /></div>
  `,
  host: { class: 'flex h-full min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-4 md:p-6' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAdminPanel {
  readonly title = input.required<string>();
  readonly description = input('');
}

/**
 * En-tête d'un écran admin : titre `h1`, introduction et zone d'outils (sélecteur de période, filtres).
 * Sur mobile, les outils passent sous le titre ; dès 1024 px, à droite.
 *
 * `<rj-admin-page-header [title]="screen.title" [description]="screen.description">
 *    <rj-period-select [(period)]="period" />
 *  </rj-admin-page-header>`
 */
@Component({
  selector: 'rj-admin-page-header',
  template: `
    <div class="flex min-w-0 flex-col gap-1">
      <h1 class="font-display text-h2 text-ink lg:text-h1">{{ title() }}</h1>
      @if (description(); as description) {
        <p class="text-body text-ink-muted">{{ description }}</p>
      }
      <div class="empty:hidden"><ng-content select="[rjHeaderMeta]" /></div>
    </div>
    <div class="flex min-w-0 flex-wrap items-end gap-2 empty:hidden lg:shrink-0 lg:justify-end"><ng-content /></div>
  `,
  host: { class: 'flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-6' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAdminPageHeader {
  readonly title = input.required<string>();
  readonly description = input('');
}

/**
 * Squelette d'un écran admin pendant le chargement : KPI (grille de 2), un graphique et un tableau.
 * `<rj-admin-page-skeleton [kpis]="4" />` ; annoncé « Chargement… » aux lecteurs d'écran.
 */
@Component({
  selector: 'rj-admin-page-skeleton',
  imports: [RjSkeleton],
  template: `
    <div class="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 xl:grid-cols-4">
      @for (item of items(); track item) {
        <rj-skeleton shape="block" class="h-28 md:h-32" />
      }
    </div>
    <rj-skeleton shape="block" class="h-80" />
    @if (table()) {
      <rj-skeleton shape="block" class="h-64" />
    }
  `,
  host: {
    role: 'status',
    'aria-busy': 'true',
    'aria-label': 'Chargement…',
    class: 'flex flex-col gap-4 md:gap-6',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAdminPageSkeleton {
  readonly kpis = input(4);
  readonly table = input(true);
  protected items(): number[] {
    return Array.from({ length: this.kpis() }, (_, index) => index);
  }
}
