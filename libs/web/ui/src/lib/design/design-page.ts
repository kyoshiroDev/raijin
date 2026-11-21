import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Page `/_design` (dev uniquement) : référence visuelle de tous les composants de base
 * dans tous leurs états. Placeholder du socle, complété par ui-mobile-first (phase 1).
 */
@Component({
  selector: 'rj-design-page',
  templateUrl: './design-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DesignPage {}
