import { ChangeDetectionStrategy, Component, type OnInit, inject } from '@angular/core';
import { PageHeader } from '../../shared/ui/page-header';
import { AlertsStore } from './alerts-store';
import { AlertRow } from './components/alert-row';
import { AlertsSummary } from './components/alerts-summary';
import { EmptyState } from '../../shared/ui/empty-state';
import { Skeleton } from '../../shared/ui/skeleton';

/** /alerts — 7-day simulated result, then the user's latest push alerts (newest first) with their follow-up. */
@Component({
  selector: 'app-alerts-page',
  imports: [AlertRow, AlertsSummary, EmptyState, PageHeader, Skeleton],
  providers: [AlertsStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header>
      <h1 class="text-xl font-black tracking-tight">Alertes</h1>
    </app-page-header>
    <main class="mx-auto max-w-lg space-y-3 px-safe pt-4">
      @if (store.error(); as e) {
        <div class="card space-y-3 text-center" role="alert">
          <p class="text-sm text-bear">{{ e }}</p>
          <button type="button" class="btn-ghost w-full" [disabled]="store.loading()" (click)="store.load()">Réessayer</button>
        </div>
      } @else if (!store.loaded()) {
        <app-skeleton variant="rows" [count]="4" label="Chargement des alertes…" />
      } @else if (store.empty()) {
        <app-empty-state class="card" title="Aucune alerte pour l’instant" hint="Les tokens qui passent le profil « Jeune calme » apparaîtront ici." />
      } @else {
        <app-alerts-summary [summary]="store.summary()" [truncated]="store.truncated()" />
        <ul class="card divide-y divide-line overflow-hidden p-0" aria-label="Dernières alertes">
          @for (item of store.items(); track item.id) {
            <li><app-alert-row [item]="item" [now]="store.now()" /></li>
          }
        </ul>
        <p class="text-center text-label text-muted">Alertes des 7 derniers jours. Aide à la décision, pas un conseil en investissement.</p>
      }
    </main>
  `,
})
export class AlertsPage implements OnInit {
  protected readonly store = inject(AlertsStore);

  ngOnInit(): void {
    void this.store.load();
  }
}
