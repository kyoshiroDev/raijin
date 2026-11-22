import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { Watch } from '@raijin/shared-contracts';
import { truncateMiddle } from '@raijin/shared-util';
import { WatchesStore } from '@raijin/web-data-access';
import { RjButton, RjEmptyState, RjErrorState, RjIcon, RjSkeleton, RjToastService, RjVerdictBadge } from '@raijin/web-ui';
import { RjFormAlert } from '../shared/form-alert';
import { TEXT_LINK } from '../shared/links';

/** Suivis concernés par le choix : actifs, ou en pause parce qu'ils dépassent la limite du plan. */
export function keepCandidates(items: readonly Watch[]): Watch[] {
  return items.filter((watch) => watch.status === 'active' || watch.pausedReason === 'plan_limit');
}

/**
 * Choix des suivis à garder actifs après l'essai (`/abonnement/suivis`, PROMPT.md §4.4) : cartes sélectionnables
 * (cases natives, clavier et lecteurs d'écran), compteur « 2 / 3 », limite claire. Les autres passent en pause,
 * jamais supprimés (`POST watches/keep`).
 */
@Component({
  selector: 'rj-keep-watches-page',
  imports: [RouterLink, RjButton, RjEmptyState, RjErrorState, RjIcon, RjSkeleton, RjVerdictBadge, RjFormAlert],
  template: `
    <div class="flex flex-col gap-6 md:gap-8">
      @if (store.status() === 'error') {
        <rj-error-state title="Raijin n’a pas pu charger tes suivis" [retrying]="retrying()" (retry)="retry()" />
      } @else if (store.status() !== 'ready') {
        <div class="flex flex-col gap-4" aria-busy="true" aria-label="Chargement des suivis">
          <rj-skeleton class="h-8 w-72 max-w-full md:h-11" />
          <rj-skeleton class="h-5 w-96 max-w-full" />
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            @for (item of [1, 2, 3, 4, 5]; track item) {
              <rj-skeleton shape="block" class="h-24" />
            }
          </div>
        </div>
      } @else if (!mustChoose()) {
        <rj-empty-state title="Tous tes suivis restent actifs" description="Ton plan couvre tous les tokens que tu suis : il n’y a rien à choisir.">
          <a rjButton="secondary" icon="suivis" routerLink="/suivis">Voir mes suivis</a>
        </rj-empty-state>
      } @else {
        <header class="flex flex-col gap-2">
          <h1 class="font-display text-h2 text-ink md:text-h1">Choisis tes {{ max() }} suivis actifs</h1>
          <p class="max-w-2xl text-body text-ink-muted">
            Le plan Gratuit permet {{ max() }} suivis actifs à la fois. Les autres sont mis en pause : ils restent dans ta liste avec leur historique, et tu pourras les reprendre plus tard.
          </p>
        </header>

        <form class="flex flex-col gap-4" (submit)="submit($event)" novalidate>
          <fieldset class="flex flex-col gap-3">
            <legend class="sr-only">Suivis à garder actifs, {{ max() }} au maximum</legend>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="tabular text-body font-semibold text-ink" aria-live="polite" data-counter>{{ selected().size }} / {{ max() }} sélectionnés</p>
              @if (full()) {
                <p class="text-body-sm text-ink-muted" data-limit-note>Limite atteinte : décoche un suivi pour en choisir un autre.</p>
              }
            </div>
            <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              @for (watch of candidates(); track watch.id) {
                <li class="h-full">
                  <label
                    class="flex h-full min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface p-4 transition-colors duration-150 ease-raijin hover:border-ink-muted has-[:checked]:border-ink has-[:checked]:bg-surface-raised has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:disabled]:hover:border-line has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus-ring"
                    [attr.data-watch]="watch.id"
                  >
                    <input
                      type="checkbox"
                      class="mt-0.5 size-5 shrink-0 cursor-pointer accent-thunder focus-visible:outline-none disabled:cursor-not-allowed"
                      [checked]="selected().has(watch.id)"
                      [disabled]="full() && !selected().has(watch.id)"
                      (change)="toggle(watch.id)"
                    />
                    <span class="flex min-w-0 flex-1 flex-col gap-2">
                      <span class="flex min-w-0 flex-col">
                        <span class="truncate font-semibold text-ink" [title]="name(watch)">{{ name(watch) }}</span>
                        <span class="tabular text-data text-ink-muted">{{ short(watch.mint) }}</span>
                      </span>
                      <span class="flex flex-wrap items-center gap-2">
                        @if (watch.lastVerdict; as verdict) {
                          <rj-verdict-badge [verdict]="verdict" />
                        }
                        @if (watch.status !== 'active') {
                          <span class="inline-flex items-center gap-1 text-body-sm text-ink-muted"><rj-icon name="pause" [size]="16" />En pause</span>
                        }
                      </span>
                    </span>
                  </label>
                </li>
              }
            </ul>
          </fieldset>

          @if (error(); as error) {
            <rj-form-alert tone="danger">{{ error }}</rj-form-alert>
          }

          <div class="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
            <a routerLink="/abonnement" [class]="link">Ou passe à Pro pour tout garder actif</a>
            <button type="submit" rjButton="primary" size="lg" [disabled]="selected().size === 0" [loading]="saving()" data-keep-submit>Garder ces suivis</button>
          </div>
        </form>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeepWatchesPage {
  protected readonly store = inject(WatchesStore);
  private readonly router = inject(Router);
  private readonly toasts = inject(RjToastService);

  protected readonly link = TEXT_LINK;
  protected readonly retrying = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly selected = signal<ReadonlySet<string>>(new Set());

  protected readonly candidates = computed(() => keepCandidates(this.store.items()));
  protected readonly max = computed(() => this.store.limits()?.maxActiveWatches ?? 0);
  protected readonly mustChoose = computed(() => {
    const limits = this.store.limits();
    return !!limits && limits.plan === 'FREE' && !limits.trialActive && this.candidates().length > limits.maxActiveWatches;
  });
  protected readonly full = computed(() => this.selected().size >= this.max());

  constructor() {
    void this.store.load(true);
    // Présélection : les suivis déjà actifs (les plus récents d'abord), dans la limite du plan.
    effect(() => {
      if (this.store.status() !== 'ready') return;
      const preselected = this.candidates()
        .filter((watch) => watch.status === 'active')
        .slice(0, this.max())
        .map((watch) => watch.id);
      untracked(() => {
        if (this.selected().size === 0) this.selected.set(new Set(preselected));
      });
    });
  }

  protected name(watch: Watch): string {
    const token = watch.token;
    const label = token?.name || token?.symbol || truncateMiddle(watch.mint, 4, 4);
    return token?.name && token.symbol ? `${label} · ${token.symbol}` : label;
  }

  protected short(mint: string): string {
    return truncateMiddle(mint, 4, 4);
  }

  protected toggle(id: string): void {
    this.error.set('');
    this.selected.update((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < this.max()) next.add(id);
      return next;
    });
  }

  protected async retry(): Promise<void> {
    this.retrying.set(true);
    await this.store.load(true);
    this.retrying.set(false);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const ids = [...this.selected()];
    if (ids.length === 0 || ids.length > this.max()) return;
    this.saving.set(true);
    const outcome = await this.store.keep(ids);
    this.saving.set(false);
    if (!outcome.ok) {
      this.error.set(outcome.error.message);
      return;
    }
    const paused = this.candidates().length - ids.length;
    this.toasts.show(`C’est noté : ${ids.length} suivi${ids.length > 1 ? 's' : ''} actif${ids.length > 1 ? 's' : ''}, ${paused} en pause.`, { tone: 'success' });
    await this.router.navigate(['/suivis']);
  }
}
