import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Watch } from '@raijin/shared-contracts';
import { RjAddressChip, RjButton, RjCard, RjIcon, RjVerdictBadge } from '@raijin/web-ui';
import { formatFullDate, formatRelative, tokenLabel, tokenSymbol } from '../shared/format';

/** Explication courte d'un suivi en pause, selon le motif. */
export function pausedText(watch: Watch): string {
  return watch.pausedReason === 'plan_limit'
    ? 'En pause : au-delà de la limite de ton plan. Raijin ne le revérifie plus.'
    : 'En pause : Raijin ne le revérifie plus jusqu’à la reprise.';
}

/** Dernière vérification, en texte court. */
export function lastCheckText(watch: Watch, now: number): string {
  if (watch.lastCheckedAt) return `Vérifié ${formatRelative(watch.lastCheckedAt, now)}`;
  return watch.status === 'paused' ? 'Pas encore vérifié' : 'Première vérification en cours';
}

/**
 * Carte d'un suivi (écran Suivis, < 1280 px) : token (nom non fiable), dernier verdict (icône +
 * mot), adresse tronquée au milieu, dernière vérification, alertes non lues, pause / reprise et
 * retrait. Pleine hauteur de sa cellule : les cartes d'une même rangée ont la même hauteur.
 */
@Component({
  selector: 'rj-watch-card',
  imports: [RouterLink, RjAddressChip, RjButton, RjCard, RjIcon, RjVerdictBadge],
  template: `
    <rj-card [interactive]="true">
      <div class="flex items-start justify-between gap-3">
        <h3 class="flex min-w-0 flex-col">
          <a
            [routerLink]="['/analyse', watch().mint]"
            [class]="'-my-2.5 block min-w-0 truncate rounded-sm py-2.5 font-display text-h3 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ' + (named() ? 'text-ink' : 'text-ink-muted')"
            [attr.aria-label]="'Voir l’analyse de ' + (named() ? name() : 'ce token')"
            data-watch-name
            >{{ named() ? name() : 'Nom non publié' }}</a
          >
          @if (symbol(); as symbol) {
            <span class="truncate text-body-sm text-ink-muted">{{ symbol }}</span>
          }
        </h3>
        @if (watch().lastVerdict; as verdict) {
          <rj-verdict-badge [verdict]="verdict" />
        } @else {
          <span class="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-line-strong px-2 py-1 text-body-sm font-semibold text-ink-muted">
            <rj-icon name="unavailable" [size]="16" />À venir
          </span>
        }
      </div>

      <rj-address-chip [address]="watch().mint" label="Adresse du token" />

      <ul class="flex flex-col gap-1.5 text-body-sm">
        <li class="flex items-center gap-2 text-ink-muted">
          <rj-icon name="clock" [size]="16" class="shrink-0" />
          @if (watch().lastCheckedAt; as checkedAt) {
            <time [attr.datetime]="checkedAt" [attr.title]="fullDate()">{{ lastCheck() }}</time>
          } @else {
            <span>{{ lastCheck() }}</span>
          }
        </li>
        <li class="flex items-center gap-2">
          @if (watch().unreadAlerts > 0) {
            <rj-icon name="bell" [size]="16" class="shrink-0 text-warn" />
            <a
              routerLink="/alertes"
              [queryParams]="{ mint: watch().mint, statut: 'non-lues' }"
              class="-my-3 inline-flex min-h-11 items-center rounded-sm font-medium text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >{{ unreadText() }}</a
            >
          } @else {
            <rj-icon name="bell" [size]="16" class="shrink-0 text-ink-muted" />
            <span class="text-ink-muted">Aucune alerte non lue</span>
          }
        </li>
      </ul>

      @if (watch().status === 'paused') {
        <p class="flex items-start gap-2 rounded-md border border-line-strong bg-surface-raised p-3 text-body-sm text-ink" data-paused>
          <rj-icon name="pause" [size]="16" class="mt-0.5 shrink-0 text-ink-muted" />
          <span>{{ paused() }}</span>
        </p>
      }

      <div rjCardFooter class="grid grid-cols-1 gap-2 pt-1 xs:grid-cols-2">
        @if (watch().status === 'active') {
          <button type="button" rjButton="secondary" icon="pause" [loading]="busy()" [attr.aria-label]="'Mettre en pause le suivi de ' + name()" (click)="togglePause.emit()">
            Pause
          </button>
        } @else {
          <button type="button" rjButton="secondary" icon="play" [loading]="busy()" [attr.aria-label]="'Reprendre le suivi de ' + name()" (click)="togglePause.emit()">
            Reprendre
          </button>
        }
        <button type="button" rjButton="ghost" icon="trash" [disabled]="busy()" [attr.aria-label]="'Retirer le suivi de ' + name()" (click)="remove.emit()">
          Retirer
        </button>
      </div>
    </rj-card>
  `,
  host: { class: 'block h-full min-w-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjWatchCard {
  readonly watch = input.required<Watch>();
  readonly busy = input(false);
  /** Instant de référence des durées relatives (fourni par l'écran, rafraîchi chaque minute). */
  readonly now = input(Date.now());
  readonly togglePause = output<void>();
  readonly remove = output<void>();

  protected readonly name = computed(() => tokenLabel(this.watch().token, this.watch().mint));
  /** Le créateur a publié un nom ou un symbole (sinon l'adresse est déjà affichée juste en dessous). */
  protected readonly named = computed(() => Boolean(this.watch().token?.name || this.watch().token?.symbol));
  protected readonly symbol = computed(() => tokenSymbol(this.watch().token));
  protected readonly lastCheck = computed(() => lastCheckText(this.watch(), this.now()));
  protected readonly fullDate = computed(() => {
    const checkedAt = this.watch().lastCheckedAt;
    return checkedAt ? formatFullDate(checkedAt) : null;
  });
  protected readonly unreadText = computed(() => {
    const count = this.watch().unreadAlerts;
    return count > 1 ? `${count} alertes non lues` : '1 alerte non lue';
  });
  protected readonly paused = computed(() => pausedText(this.watch()));
}
