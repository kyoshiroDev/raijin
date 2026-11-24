import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import type { AnalysisCheckId } from '@raijin/shared-contracts';
import { RjBottomSheet, RjButton } from '@raijin/web-ui';
import { CHECK_HELP } from './check-help';
import { ANALYSIS_CHECK_LABELS } from './labels';

/**
 * Bottom sheet « En savoir plus » d'un contrôle. Chargée à la première ouverture (`@defer` du résultat,
 * docs/ARCHITECTURE.md §10.6, G4) : ni les textes pédagogiques ni `RjBottomSheet` ne sont dans le bundle initial.
 */
@Component({
  selector: 'rj-check-help-sheet',
  imports: [RjBottomSheet, RjButton],
  template: `
    <rj-bottom-sheet [(open)]="open" [title]="title()" description="Comprendre ce contrôle en 30 secondes">
      @if (help(); as help) {
        <div class="flex flex-col gap-4 pb-2">
          <section class="flex flex-col gap-1">
            <h3 class="text-body font-semibold text-ink">Ce que c’est</h3>
            <p class="text-body text-ink-muted">{{ help.what }}</p>
          </section>
          <section class="flex flex-col gap-1">
            <h3 class="text-body font-semibold text-ink">Pourquoi c’est important</h3>
            <p class="text-body text-ink-muted">{{ help.why }}</p>
          </section>
          <section class="flex flex-col gap-1">
            <h3 class="text-body font-semibold text-ink">Comment Raijin le vérifie</h3>
            <p class="text-body text-ink-muted">{{ help.how }}</p>
          </section>
        </div>
      }
      <button rjSheetFooter type="button" rjButton="secondary" (click)="open.set(false)">J’ai compris</button>
    </rj-bottom-sheet>
  `,
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjCheckHelpSheet {
  readonly open = model(false);
  readonly checkId = input<AnalysisCheckId | null>(null);

  protected readonly help = computed(() => {
    const id = this.checkId();
    return id ? CHECK_HELP[id] : null;
  });
  protected readonly title = computed(() => {
    const id = this.checkId();
    return id ? ANALYSIS_CHECK_LABELS[id] : 'En savoir plus';
  });
}
