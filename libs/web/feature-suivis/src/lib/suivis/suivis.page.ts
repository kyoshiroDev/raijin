import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Watch } from '@raijin/shared-contracts';
import { WatchesStore, planName, watchLimitExplanation } from '@raijin/web-data-access';
import {
  RjAddressChip,
  RjBottomSheet,
  RjButton,
  RjCard,
  RjEmptyState,
  RjErrorState,
  RjIcon,
  RjSkeleton,
  RjToastService,
  RjVerdictBadge,
} from '@raijin/web-ui';
import { formatFullDate, tokenLabel, tokenSymbol } from '../shared/format';
import { RjWatchCard, lastCheckText, pausedText } from './watch-card';

/** Rafraîchissement des durées relatives (« il y a 3 min »). */
const CLOCK_MS = 60_000;

/**
 * Écran « Suivis » : cartes empilées sur mobile, grille 2 colonnes dès 768 px, tableau dense dès
 * 1280 px. Compteur « 2 / 3 suivis actifs » (limites lues dans l'API), suivis en pause expliqués,
 * pause / reprise, retrait avec confirmation. Skeleton, état vide (Rai bravo), erreur (Rai alerte).
 * Seule action jaune : « Analyser un token » (on suit un token depuis son analyse).
 */
@Component({
  selector: 'rj-suivis-page',
  imports: [
    RouterLink,
    RjAddressChip,
    RjBottomSheet,
    RjButton,
    RjCard,
    RjEmptyState,
    RjErrorState,
    RjIcon,
    RjSkeleton,
    RjVerdictBadge,
    RjWatchCard,
  ],
  template: `
    <div class="flex flex-col gap-6 md:gap-8">
      <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div class="flex min-w-0 flex-col gap-1">
          <h1 class="font-display text-h2 text-ink md:text-h1">Suivis</h1>
          <p class="text-body text-ink-muted">Raijin revérifie ces tokens et te prévient si un signal de risque apparaît.</p>
        </div>
        @if (store.status() === 'ready' && store.items().length > 0) {
          <a rjButton="primary" routerLink="/analyse" icon="analyse" class="shrink-0">Analyser un token</a>
        }
      </header>

      @switch (store.status()) {
        @case ('error') {
          <rj-error-state
            title="Raijin n’a pas pu charger tes suivis"
            [description]="store.error()?.message ?? ''"
            [retrying]="retrying()"
            (retry)="retry()"
          />
        }
        @case ('ready') {
          @if (limits(); as limits) {
            <section
              class="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 md:flex-row md:items-center md:justify-between md:gap-6 md:px-6"
              aria-label="Limite de ton plan"
              data-plan-limit
            >
              <div class="flex min-w-0 flex-col gap-2 md:flex-1">
                <p class="flex flex-wrap items-baseline gap-x-2 text-body text-ink">
                  <span class="tabular text-h3 font-semibold" data-watch-count>{{ store.activeCount() }} / {{ limits.maxActiveWatches }}</span>
                  <span>suivis actifs avec ton {{ plan() }}</span>
                </p>
                <div
                  class="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised md:max-w-sm"
                  role="meter"
                  aria-label="Suivis actifs"
                  [attr.aria-valuenow]="store.activeCount()"
                  aria-valuemin="0"
                  [attr.aria-valuemax]="limits.maxActiveWatches"
                  [attr.aria-valuetext]="store.activeCount() + ' sur ' + limits.maxActiveWatches"
                >
                  <div [class]="'h-full rounded-full transition-[width] duration-200 ease-raijin ' + (store.limitReached() ? 'bg-warn' : 'bg-ink-muted')" [style.width.%]="meter()"></div>
                </div>
              </div>
              <p class="text-body-sm text-ink-muted md:max-w-sm md:text-right">
                @if (store.limitReached()) {
                  Limite atteinte : mets en pause ou retire un suivi pour en ajouter un autre.
                } @else {
                  {{ remainingText() }}
                }
              </p>
            </section>
          }

          @if (planPausedCount() > 0) {
            <p class="flex items-start gap-3 rounded-lg border border-line-strong bg-surface-raised p-4 text-body text-ink" role="note" data-plan-paused>
              <rj-icon name="info" [size]="20" class="mt-0.5 shrink-0 text-info" />
              <span>{{ planPausedText() }}</span>
            </p>
          }

          @if (store.items().length === 0) {
            <rj-empty-state
              title="Aucun token suivi pour l’instant"
              description="Analyse un token puis touche « Suivre » : Raijin le revérifie régulièrement et te prévient si sa liquidité est retirée, si une autorité est réactivée ou si son verdict se dégrade."
            >
              <a rjButton="primary" routerLink="/analyse" icon="analyse">Analyser un token</a>
            </rj-empty-state>
          } @else {
            <ul class="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 xl:hidden" aria-label="Tokens suivis">
              @for (watch of store.items(); track watch.id) {
                <li class="min-w-0">
                  <rj-watch-card [watch]="watch" [now]="now()" [busy]="isBusy(watch)" (togglePause)="togglePause(watch)" (remove)="askRemove(watch)" />
                </li>
              }
            </ul>

            <div class="hidden overflow-hidden rounded-lg border border-line bg-surface xl:block">
              <table class="w-full table-fixed text-left text-body-sm">
                <caption class="sr-only">Tokens suivis</caption>
                <colgroup>
                  <col class="w-[22%]" /><col class="w-[14%]" /><col class="w-[16%]" /><col class="w-[12%]" /><col class="w-[36%]" />
                </colgroup>
                <thead class="border-b border-line text-label font-medium tracking-wide text-ink-muted uppercase">
                  <tr>
                    <th scope="col" class="px-6 py-3 font-medium">Token</th>
                    <th scope="col" class="px-3 py-3 font-medium">Dernier verdict</th>
                    <th scope="col" class="px-3 py-3 font-medium">Vérification</th>
                    <th scope="col" class="px-3 py-3 font-medium">Alertes</th>
                    <th scope="col" class="px-6 py-3 text-right font-medium"><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-line">
                  @for (watch of store.items(); track watch.id) {
                    <tr class="align-middle transition-colors duration-150 ease-raijin hover:bg-surface-raised">
                      <td class="px-6 py-3">
                        <div class="flex min-w-0 flex-col gap-1">
                          <a
                            [routerLink]="['/analyse', watch.mint]"
                            class="-my-2.5 block truncate rounded-sm py-2.5 text-body font-semibold text-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                            [attr.aria-label]="visibleName(watch) + ', voir l’analyse'"
                            [attr.title]="visibleName(watch)"
                            >{{ label(watch) }}@if (symbol(watch); as symbol) {<span class="font-normal text-ink-muted"> · {{ symbol }}</span>}</a
                          >
                          <rj-address-chip [address]="watch.mint" label="Adresse du token" />
                        </div>
                      </td>
                      <td class="px-3 py-3">
                        @if (watch.lastVerdict; as verdict) {
                          <rj-verdict-badge [verdict]="verdict" />
                        } @else {
                          <span class="inline-flex items-center gap-1.5 text-ink-muted"><rj-icon name="unavailable" [size]="16" />À venir</span>
                        }
                      </td>
                      <td class="px-3 py-3 text-ink-muted">
                        @if (watch.status === 'paused') {
                          <span class="inline-flex items-center gap-1.5 text-ink" [attr.title]="paused(watch)"><rj-icon name="pause" [size]="16" class="text-ink-muted" />En pause</span>
                          <span class="block text-label text-ink-muted">{{ watch.pausedReason === 'plan_limit' ? 'Limite du plan' : 'Par toi' }}</span>
                        } @else if (watch.lastCheckedAt; as checkedAt) {
                          <time [attr.datetime]="checkedAt" [attr.title]="fullDate(checkedAt)">{{ lastCheck(watch) }}</time>
                        } @else {
                          {{ lastCheck(watch) }}
                        }
                      </td>
                      <td class="px-3 py-3">
                        @if (watch.unreadAlerts > 0) {
                          <a
                            routerLink="/alertes"
                            [queryParams]="{ mint: watch.mint, statut: 'non-lues' }"
                            class="inline-flex min-h-11 items-center gap-1.5 rounded-sm font-medium text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                            ><rj-icon name="bell" [size]="16" class="text-warn" />{{ watch.unreadAlerts }} non lue{{ watch.unreadAlerts > 1 ? 's' : '' }}</a
                          >
                        } @else {
                          <span class="text-ink-muted">Aucune</span>
                        }
                      </td>
                      <td class="px-6 py-3">
                        <div class="flex justify-end gap-2">
                          @if (watch.status === 'active') {
                            <button type="button" rjButton="secondary" icon="pause" class="min-w-36" [loading]="isBusy(watch)" [attr.aria-label]="'Mettre en pause le suivi de ' + label(watch)" (click)="togglePause(watch)">Pause</button>
                          } @else {
                            <button type="button" rjButton="secondary" icon="play" class="min-w-36" [loading]="isBusy(watch)" [attr.aria-label]="'Reprendre le suivi de ' + label(watch)" (click)="togglePause(watch)">Reprendre</button>
                          }
                          <button type="button" rjButton="ghost" icon="trash" [disabled]="isBusy(watch)" [attr.aria-label]="'Retirer le suivi de ' + label(watch)" (click)="askRemove(watch)">Retirer</button>
                        </div>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        }
        @default {
          <div class="flex flex-col gap-6 md:gap-8" aria-busy="true" aria-label="Chargement des suivis">
            <rj-skeleton shape="block" class="h-24 md:h-20" />
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
              @for (card of skeletonCards; track card) {
                <rj-card>
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex flex-1 flex-col gap-2"><rj-skeleton class="h-5 w-32" /><rj-skeleton class="h-4 w-16" /></div>
                    <rj-skeleton class="h-7 w-24" />
                  </div>
                  <rj-skeleton shape="block" class="h-11 w-48" />
                  <div class="flex flex-col gap-2"><rj-skeleton class="h-4 w-40" /><rj-skeleton class="h-4 w-36" /></div>
                  <div rjCardFooter class="grid grid-cols-1 gap-2 pt-1 xs:grid-cols-2">
                    <rj-skeleton shape="block" class="h-11" /><rj-skeleton shape="block" class="h-11" />
                  </div>
                </rj-card>
              }
            </div>
          </div>
        }
      }
    </div>

    <rj-bottom-sheet [(open)]="removeOpen" title="Retirer ce suivi ?" [description]="removeText()">
      <button rjSheetFooter type="button" rjButton="ghost" (click)="removeOpen.set(false)">Annuler</button>
      <button rjSheetFooter type="button" rjButton="danger" icon="trash" [loading]="removing()" (click)="confirmRemove()">Retirer le suivi</button>
    </rj-bottom-sheet>

    <rj-bottom-sheet [(open)]="limitOpen" title="Limite de suivis atteinte" [description]="limitText()">
      <p class="pb-2 text-body text-ink-muted">Pour reprendre ce suivi, mets d’abord en pause ou retire un suivi actif.</p>
      <button rjSheetFooter type="button" rjButton="secondary" (click)="limitOpen.set(false)">J’ai compris</button>
    </rj-bottom-sheet>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SuivisPage {
  protected readonly store = inject(WatchesStore);
  private readonly toasts = inject(RjToastService);

  protected readonly skeletonCards = [1, 2, 3, 4];
  protected readonly retrying = signal(false);
  protected readonly removeOpen = signal(false);
  protected readonly limitOpen = signal(false);
  protected readonly removing = signal(false);
  private readonly removeTarget = signal<Watch | null>(null);
  protected readonly now = signal(Date.now());

  protected readonly limits = this.store.limits;
  protected readonly plan = computed(() => {
    const limits = this.limits();
    return limits ? planName(limits) : '';
  });
  protected readonly meter = computed(() => {
    const max = this.limits()?.maxActiveWatches ?? 0;
    return max > 0 ? Math.min(100, Math.round((this.store.activeCount() / max) * 100)) : 0;
  });
  protected readonly remainingText = computed(() => {
    const max = this.limits()?.maxActiveWatches ?? 0;
    const left = Math.max(0, max - this.store.activeCount());
    return left > 1 ? `Tu peux encore suivre ${left} tokens.` : 'Tu peux encore suivre 1 token.';
  });
  protected readonly planPausedCount = computed(() => this.store.items().filter((watch) => watch.pausedReason === 'plan_limit').length);
  protected readonly planPausedText = computed(() => {
    const count = this.planPausedCount();
    return count > 1
      ? `${count} suivis sont en pause car ils dépassent la limite de ton plan. Ils restent dans ta liste avec leur historique, mais Raijin ne les revérifie plus. Retire ou mets en pause un autre suivi pour en reprendre un.`
      : '1 suivi est en pause car il dépasse la limite de ton plan. Il reste dans ta liste avec son historique, mais Raijin ne le revérifie plus. Retire ou mets en pause un autre suivi pour le reprendre.';
  });
  protected readonly removeText = computed(() => {
    const watch = this.removeTarget();
    const name = watch ? tokenLabel(watch.token, watch.mint) : 'ce token';
    return `Raijin arrête de surveiller ${name}. Les alertes déjà reçues restent dans ton historique.`;
  });
  protected readonly limitText = computed(() => watchLimitExplanation(this.limits()));

  constructor() {
    void this.store.load(true);
    const timer = setInterval(() => this.now.set(Date.now()), CLOCK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected label(watch: Watch): string {
    return tokenLabel(watch.token, watch.mint);
  }

  /** Texte visible du lien du tableau (nom · symbole), repris en tête du nom accessible. */
  protected visibleName(watch: Watch): string {
    const symbol = this.symbol(watch);
    return symbol ? `${this.label(watch)} · ${symbol}` : this.label(watch);
  }

  protected symbol(watch: Watch): string | null {
    return tokenSymbol(watch.token);
  }

  protected lastCheck(watch: Watch): string {
    return lastCheckText(watch, this.now());
  }

  protected fullDate(iso: string): string {
    return formatFullDate(iso);
  }

  protected paused(watch: Watch): string {
    return pausedText(watch);
  }

  protected isBusy(watch: Watch): boolean {
    return this.store.busy().has(watch.id);
  }

  protected async retry(): Promise<void> {
    this.retrying.set(true);
    await this.store.load(true);
    this.retrying.set(false);
  }

  protected async togglePause(watch: Watch): Promise<void> {
    const next = watch.status === 'active' ? 'paused' : 'active';
    const outcome = await this.store.setStatus(watch.id, next);
    if (outcome.ok) {
      this.toasts.show(next === 'paused' ? 'Suivi mis en pause.' : 'Suivi repris : Raijin le revérifie de nouveau.', { tone: 'success' });
    } else if (outcome.error.code === 'WATCH_LIMIT_REACHED') {
      this.limitOpen.set(true);
    } else {
      this.toasts.show(outcome.error.message, { tone: 'error' });
    }
  }

  protected askRemove(watch: Watch): void {
    this.removeTarget.set(watch);
    this.removeOpen.set(true);
  }

  protected async confirmRemove(): Promise<void> {
    const watch = this.removeTarget();
    if (!watch) return;
    this.removing.set(true);
    const outcome = await this.store.remove(watch.id);
    this.removing.set(false);
    this.removeOpen.set(false);
    if (outcome.ok) {
      this.toasts.show('Suivi retiré.');
    } else {
      this.toasts.show(outcome.error.message, { tone: 'error' });
    }
  }
}
