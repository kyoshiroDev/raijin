import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { BOOK_LABEL, type PaperBook } from '@raijin/bench-web-logic';
import { Sheet } from '../../../shared/ui/sheet';

/** Confirmation step of « Réinitialiser à 1 SOL » for one book (never window.confirm). */
@Component({
  selector: 'app-reset-wallet-sheet',
  imports: [Sheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-sheet [heading]="heading()" [open]="book() !== null" (openChange)="$event || dismissed.emit()">
      <div class="space-y-4" data-reset-confirm [attr.data-reset-book]="book()">
        <p class="text-sm">
          Le solde virtuel du portefeuille <strong>{{ label() }}</strong> repart à <strong>1 SOL</strong> et ses statistiques
          recommencent de zéro. Les autres portefeuilles ne changent pas. C’est une simulation : aucun argent réel n’est concerné.
        </p>
        <button type="button" class="btn w-full bg-bear text-base hover:brightness-110" data-confirm-reset [disabled]="busy()" (click)="confirmed.emit()">
          {{ busy() ? 'Réinitialisation…' : 'Oui, réinitialiser' }}
        </button>
        <button type="button" class="btn-ghost w-full" data-cancel-reset (click)="dismissed.emit()">Annuler</button>
      </div>
    </app-sheet>
  `,
})
export class ResetWalletSheet {
  /** Book being confirmed; null = closed. */
  readonly book = input<PaperBook | null>(null);
  readonly busy = input(false);
  readonly confirmed = output();
  readonly dismissed = output();

  protected readonly label = computed(() => {
    const b = this.book();
    return b === null ? '' : BOOK_LABEL[b];
  });
  protected readonly heading = computed(() => `Réinitialiser « ${this.label()} » ?`);
}
