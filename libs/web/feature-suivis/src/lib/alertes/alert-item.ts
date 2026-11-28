import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Alert } from '@raijin/shared-contracts';
import { truncateMiddle } from '@raijin/shared-util';
import { RjButton, RjVerdictBadge } from '@raijin/web-ui';
import { alertSentence, alertTitle, formatFullDate, formatRelative, tokenLabel } from '../shared/format';

/**
 * Une alerte de l'historique : type, gravité (icône + mot), phrase factuelle, token (nom non
 * fiable + adresse tronquée), date, état lu / non lu (écrit en toutes lettres, pas seulement par
 * la graisse), lien vers l'analyse et bouton lu / non lu.
 */
@Component({
  selector: 'rj-alert-item',
  imports: [RouterLink, RjButton, RjVerdictBadge],
  template: `
    <article
      tabindex="-1"
      [attr.aria-labelledby]="titleId()"
      [attr.data-unread]="unread() ? 'true' : null"
      [class]="classes()"
    >
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <rj-verdict-badge [verdict]="alert().severity" />
        <h3 [id]="titleId()" class="min-w-0 text-body font-semibold text-ink">{{ title() }}</h3>
        @if (unread()) {
          <span class="inline-flex items-center gap-1.5 text-label font-medium text-ink" data-unread-label>
            <span class="size-2 rounded-full bg-info" aria-hidden="true"></span>Non lue
          </span>
        }
      </div>
      <p class="text-body text-ink">{{ sentence() }}</p>
      <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-ink-muted">
        <!-- Token sans nom publié : l'adresse seule (pas deux fois la même adresse tronquée). -->
        @if (named()) {
          <span class="min-w-0 truncate font-medium text-ink" [attr.title]="token()">{{ token() }}</span>
        }
        <span class="tabular text-data" [attr.title]="alert().mint">{{ shortMint() }}</span>
        <span aria-hidden="true">·</span>
        <time [attr.datetime]="alert().createdAt" [attr.title]="fullDate()">{{ relative() }}</time>
      </p>
      <div class="-mx-4 -mb-2 flex flex-wrap items-center gap-1 pt-1">
        <a rjButton="ghost" iconEnd="arrowRight" [routerLink]="['/analyse', alert().mint]" [attr.aria-label]="'Voir l’analyse de ' + token()">Voir l’analyse</a>
        <button
          type="button"
          rjButton="ghost"
          [icon]="unread() ? 'check' : 'bell'"
          [attr.aria-label]="(unread() ? 'Marquer lue : ' : 'Marquer non lue : ') + title() + ', ' + token()"
          (click)="toggleRead.emit(unread())"
        >
          {{ unread() ? 'Marquer lue' : 'Marquer non lue' }}
        </button>
      </div>
    </article>
  `,
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAlertItem {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly alert = input.required<Alert>();
  readonly highlighted = input(false);
  readonly now = input(Date.now());
  /** `true` = marquer lue, `false` = marquer non lue. */
  readonly toggleRead = output<boolean>();

  protected readonly unread = computed(() => this.alert().readAt === null);
  protected readonly titleId = computed(() => `rj-alert-${this.alert().id}`);
  protected readonly title = computed(() => alertTitle(this.alert()));
  protected readonly sentence = computed(() => alertSentence(this.alert()));
  protected readonly token = computed(() => tokenLabel(this.alert().token, this.alert().mint));
  protected readonly named = computed(() => Boolean(this.alert().token?.name || this.alert().token?.symbol));
  protected readonly shortMint = computed(() => truncateMiddle(this.alert().mint, 4, 4));
  protected readonly relative = computed(() => formatRelative(this.alert().createdAt, this.now()));
  protected readonly fullDate = computed(() => formatFullDate(this.alert().createdAt));
  protected readonly classes = computed(() =>
    [
      'flex flex-col gap-2 rounded-lg border p-4 transition-colors duration-200 ease-raijin focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring md:p-6',
      this.highlighted() ? 'border-ink-muted bg-surface-raised' : this.unread() ? 'border-line-strong bg-surface' : 'border-line bg-surface',
    ].join(' '),
  );

  /** Met l'alerte à l'écran et lui donne le focus (ouverture depuis une notification). */
  reveal(): void {
    const article = this.host.nativeElement.querySelector('article');
    article?.scrollIntoView?.({ block: 'center' });
    article?.focus({ preventScroll: true });
  }
}
