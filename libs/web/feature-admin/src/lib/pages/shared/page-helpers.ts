import { ChangeDetectionStrategy, Component, effect, input, output, untracked } from '@angular/core';
import type { AdminPeriod } from '@raijin/shared-contracts';
import type { AdminReport } from '@raijin/web-data-access';
import { RjErrorState } from '@raijin/web-ui';
import { RjAdminPageSkeleton } from '../../ui';

/**
 * Recharge un écran à chaque changement de sa requête (période, dimension…) : `query()` est suivi, le chargement non.
 * À appeler dans le constructeur d'une page (contexte d'injection).
 */
export function reloadOn<Q, T>(query: () => Q, report: AdminReport<T>, load: (query: Q) => Promise<T>): void {
  effect(() => {
    const value = query();
    untracked(() => void report.load(() => load(value)));
  });
}

/** « vs 7 j préc. » sous la variation d'un KPI. */
export function comparisonLabel(period: AdminPeriod): string {
  switch (period) {
    case 'today':
      return 'vs hier';
    case '7d':
      return 'vs 7 j préc.';
    case '30d':
      return 'vs 30 j préc.';
    case '90d':
      return 'vs 90 j préc.';
  }
}

/** Périodes proposées par les écrans statistiques. */
export const ADMIN_PAGE_PERIODS: readonly AdminPeriod[] = ['today', '7d', '30d', '90d'];

/** Intitulé de la comparaison dans la légende des graphiques. */
export function previousLabel(period: AdminPeriod): string {
  return period === 'today' ? 'Hier' : 'Période précédente';
}

/**
 * États communs d'un écran : squelette au premier chargement, erreur avec « Réessayer » si rien n'est affiché, sinon
 * le contenu (projeté) ; pendant un rechargement, le contenu reste visible et la zone est marquée `aria-busy`.
 *
 * `<rj-admin-report-state [report]="report" [kpis]="4" (retry)="reload()"> … </rj-admin-report-state>`
 */
@Component({
  selector: 'rj-admin-report-state',
  imports: [RjAdminPageSkeleton, RjErrorState],
  template: `
    @if (report().data() === null) {
      @if (report().status() === 'error') {
        <rj-error-state
          title="Impossible de charger cet écran"
          description="L’API n’a pas répondu. Vérifie ta connexion puis réessaie."
          [retrying]="false"
          (retry)="retry.emit()"
        />
      } @else {
        <rj-admin-page-skeleton [kpis]="kpis()" [table]="table()" />
      }
    } @else {
      <div class="flex flex-col gap-4 transition-opacity duration-150 ease-raijin md:gap-6" [class.opacity-60]="report().status() === 'loading'" [attr.aria-busy]="report().status() === 'loading'">
        <ng-content />
      </div>
    }
  `,
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAdminReportState {
  readonly report = input.required<AdminReport<unknown>>();
  readonly kpis = input(4);
  readonly table = input(true);
  readonly retry = output<void>();
}
