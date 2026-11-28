import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { RjIcon } from '../icon/icon';

/**
 * Bandeau d'essai Pro (PROMPT.md §4.4) : fond `thunder-soft`, texte sobre, un lien et un bouton de fermeture.
 * Aucune animation, aucun compte à rebours : le texte change une fois par jour.
 */
@Component({
  selector: 'rj-trial-banner',
  imports: [RjIcon, RouterLink],
  template: `
    <rj-icon name="safe" [size]="20" class="mt-0.5 shrink-0 text-thunder-ink sm:mt-0" />
    <p class="flex min-w-0 flex-1 flex-col gap-x-3 sm:flex-row sm:flex-wrap sm:items-center">
      <span class="font-medium text-ink" data-trial-text>{{ text() }}</span>
      <a
        [routerLink]="linkPath()"
        class="-my-2 inline-flex min-h-11 items-center self-start rounded-sm text-body-sm text-ink underline decoration-line-strong underline-offset-4 transition-colors duration-150 ease-raijin hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring sm:self-auto"
        >{{ linkLabel() }}</a
      >
    </p>
    <button
      type="button"
      class="-my-2 -mr-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 ease-raijin hover:bg-surface-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      aria-label="Masquer le bandeau jusqu’à demain"
      (click)="dismiss.emit()"
    >
      <rj-icon name="close" [size]="20" />
    </button>
  `,
  host: {
    role: 'region',
    'aria-label': 'Essai Pro',
    class: 'flex items-start gap-3 rounded-lg border border-line bg-thunder-soft px-4 py-3 text-body-sm sm:items-center',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjTrialBanner {
  readonly text = input.required<string>();
  readonly linkLabel = input.required<string>();
  readonly linkPath = input.required<string>();
  readonly dismiss = output<void>();
}
