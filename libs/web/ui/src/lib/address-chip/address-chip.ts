import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { truncateMiddle } from '@raijin/shared-util';
import { RjClipboard } from '../clipboard/clipboard';
import { RjIcon } from '../icon/icon';

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Adresse Solana en mono, tronquée au milieu (`7xKX…gAsU`), valeur complète en `title`,
 * bouton copier avec retour « Copié » annoncé aux lecteurs d'écran.
 */
@Component({
  selector: 'rj-address-chip',
  imports: [RjIcon],
  template: `
    <span class="tabular min-w-0 truncate pl-3 text-data text-ink" [attr.title]="address()">
      <span class="sr-only">{{ label() }} : {{ address() }}</span>
      <span aria-hidden="true">{{ short() }}</span>
    </span>
    <button
      type="button"
      class="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-body-sm font-medium transition-colors duration-150 ease-raijin hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      [class.text-ink-muted]="state() === 'idle'"
      [class.text-safe]="state() === 'copied'"
      [class.text-danger]="state() === 'failed'"
      [attr.aria-label]="state() === 'idle' ? 'Copier l’adresse' : null"
      (click)="copy()"
    >
      @switch (state()) {
        @case ('copied') {
          <rj-icon name="check" [size]="16" />
          <span>Copié</span>
        }
        @case ('failed') {
          <rj-icon name="circleAlert" [size]="16" />
          <span>Échec</span>
        }
        @default {
          <rj-icon name="copy" [size]="16" />
        }
      }
    </button>
    <span class="sr-only" aria-live="polite">{{ announcement() }}</span>
  `,
  host: {
    class: 'inline-flex min-h-11 w-fit max-w-full items-center gap-1 rounded-md border border-line bg-surface-raised pr-0.5',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RjAddressChip {
  private readonly clipboard = inject(RjClipboard);
  private timer: ReturnType<typeof setTimeout> | undefined;

  readonly address = input.required<string>();
  readonly label = input('Adresse');
  readonly head = input(4);
  readonly tail = input(4);

  protected readonly state = signal<CopyState>('idle');
  protected readonly short = computed(() => truncateMiddle(this.address(), this.head(), this.tail()));
  protected readonly announcement = computed(() => {
    switch (this.state()) {
      case 'copied':
        return 'Adresse copiée';
      case 'failed':
        return 'Copie impossible : sélectionne l’adresse à la main';
      default:
        return '';
    }
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  async copy(): Promise<void> {
    const ok = await this.clipboard.copy(this.address());
    this.state.set(ok ? 'copied' : 'failed');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.state.set('idle'), 2000);
  }
}
