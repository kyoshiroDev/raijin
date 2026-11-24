import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MIN_SAMPLE_FOR_RATE } from '../performance-stats';
import type { BookComparisonView } from '../book-comparison';
import type { BookCompareState } from '../performance-store';
import { TestBooksProgress } from './test-books-progress';
import { TestBooksTable } from './test-books-table';

/** « Portefeuilles de test »: Calme SL −30 % / Calme SL −40 % / Frénésie SL −30 % (témoin), with its own states. */
@Component({
  selector: 'app-test-books-section',
  imports: [TestBooksProgress, TestBooksTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block space-y-2', 'data-test-books': '' },
  template: `
    <h2 id="perf-test-books" class="text-xs font-semibold tracking-wide text-muted uppercase">Portefeuilles de test</h2>
    @switch (state()) {
      @case ('ready') {
        @let v = view();
        <div class="card space-y-4 p-3" data-test-books-card>
          @if (v.hasData) {
            <app-test-books-table [view]="v" />
          } @else {
            <p class="text-sm text-muted" data-test-books-empty>Aucun trade simulé dans les portefeuilles de test pour l’instant.</p>
          }
          <div class="space-y-2">
            <h3 class="text-sm font-bold">Progression vers {{ v.progress[0]!.target }} trades par portefeuille</h3>
            <app-test-books-progress [items]="v.progress" />
          </div>
          <p class="text-label text-muted">
            Jeunes paires PumpSwap (&lt; 24 h), tout à ×2, entrée au scan suivant, chaque token qui remplit le profil.
            Frénésie est un témoin : il n’envoie aucune alerte, seul son portefeuille virtuel tourne. Taux par trade
            clôturé, en clair à partir de {{ minSample }} trades ; en dessous, « touchés / trades » en gris
            (échantillon trop petit). Simulation : aide à la décision, pas un conseil en investissement.
          </p>
        </div>
      }
      @case ('unavailable') {
        <p class="card text-sm text-muted" role="status" data-test-books-unavailable>Comparaison des portefeuilles de test pas encore disponible côté serveur.</p>
      }
      @case ('error') {
        <div class="card space-y-3 text-center" role="alert" data-test-books-error>
          <p class="text-sm text-bear">{{ errorText() }}</p>
          <button type="button" class="btn-ghost w-full" (click)="retry.emit()">Réessayer</button>
        </div>
      }
      @default {
        <p class="py-4 text-center text-sm text-muted" role="status">Chargement des portefeuilles de test…</p>
      }
    }
  `,
})
export class TestBooksSection {
  readonly state = input.required<BookCompareState>();
  readonly view = input.required<BookComparisonView>();
  readonly errorText = input('');
  readonly retry = output();

  protected readonly minSample = MIN_SAMPLE_FOR_RATE;
}
