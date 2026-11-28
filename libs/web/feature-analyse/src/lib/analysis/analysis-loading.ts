import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RjCard, RjSkeleton } from '@raijin/web-ui';
import { RjShieldScan } from './shield-scan';

/**
 * Chargement d'une analyse : bouclier animé + texte d'état, et squelette aux dimensions du
 * résultat (même grille que `rj-analysis-result`, pas de saut de mise en page à l'arrivée).
 */
@Component({
  selector: 'rj-analysis-loading',
  imports: [RjCard, RjSkeleton, RjShieldScan],
  template: `
    <div class="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
      <rj-card>
        <div class="flex items-center gap-4" role="status">
          <rj-shield-scan class="h-18 w-15 shrink-0" />
          <div class="flex min-w-0 flex-col gap-1">
            <p class="font-display text-h3 text-ink">{{ title() }}</p>
            <p class="text-body-sm text-ink-muted">{{ description() }}</p>
          </div>
        </div>
        <rj-skeleton class="h-11 w-56 max-w-full" />
        <rj-skeleton shape="block" class="h-36" />
        <rj-skeleton class="h-5 w-48 max-w-full" />
        <div rjCardFooter class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <rj-skeleton shape="block" class="h-11" />
          <rj-skeleton shape="block" class="h-11" />
        </div>
      </rj-card>
      <rj-card>
        <rj-skeleton class="h-6 w-40" />
        <div class="flex flex-col divide-y divide-line">
          @for (row of rows; track row) {
            <div class="flex items-start gap-3 py-3">
              <rj-skeleton shape="block" class="size-9 shrink-0 rounded-md" />
              <div class="flex min-w-0 flex-1 flex-col gap-2">
                <rj-skeleton class="h-4 w-2/5" />
                <rj-skeleton class="h-3.5 w-4/5" />
              </div>
            </div>
          }
        </div>
      </rj-card>
    </div>
  `,
  host: { class: 'block', 'aria-busy': 'true' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAnalysisLoading {
  readonly title = input('Analyse en cours');
  readonly description = input('Raijin vérifie les autorités, la liquidité, les holders et la revente.');
  protected readonly rows = [1, 2, 3, 4, 5, 6, 7, 8, 9];
}
