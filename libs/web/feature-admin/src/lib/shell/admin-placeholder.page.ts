import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RjEmptyState } from '@raijin/web-ui';
import { RjAdminPageHeader } from '../ui/layout';
import { adminScreen } from './admin-screens';

/**
 * Gabarit d'un écran admin pas encore livré : en-tête de l'écran et état vide. Chaque ligne de `lib.routes.ts`
 * qui y pointe est remplacée par la vraie page (admin-analytics, `pages/**`).
 */
@Component({
  selector: 'rj-admin-placeholder-page',
  imports: [RjAdminPageHeader, RjEmptyState],
  template: `
    <div class="flex flex-col gap-6">
      <rj-admin-page-header [title]="current().title" [description]="current().description" />
      <rj-empty-state title="Écran en préparation" description="Les données de cet écran arrivent bientôt. Les autres écrans restent consultables." />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminPlaceholderPage {
  /** Chemin de l'écran (donnée de route `screen`). */
  readonly screen = input('');
  protected readonly current = computed(() => adminScreen(this.screen()));
}
